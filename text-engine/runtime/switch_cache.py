"""vLLM secondary host tier for reusable blocks between engine processes."""
from collections import deque
import hashlib
import json

from vllm.v1.kv_offload.base import Locality, LookupResult, Medium
from vllm.v1.kv_offload.file_mapper import FileMapper
from vllm.v1.kv_offload.tiering.base import JobResult, RequestOffloadingContext, SecondaryTierManager
from vllm.v1.kv_offload.tiering.fs.thread_pool import DualQueueThreadPool
from vllm.v1.kv_offload.tiering.spec import TieringOffloadingSpec
from prefix_ram import RamClient, SOCKET_NAME
from xpu_cpu_offload import BoundedXPUOffloadingSpec


class SwitchCacheSpec(BoundedXPUOffloadingSpec, TieringOffloadingSpec):
    """Preserve bounded XPU transfers while enabling the upstream tier manager."""


class SwitchRamTier(SecondaryTierManager):
    medium = Medium.CPU

    def __init__(self, offloading_spec, primary_kv_view, tier_type, release_id, backpressure_detector=None):
        super().__init__(offloading_spec, primary_kv_view, tier_type, backpressure_detector)
        self.locality = Locality.LOCAL
        # Use vLLM's own model, partition and layout identity plus the frozen
        # release identity. FileMapper only constructs metadata here.
        mapper = FileMapper.from_offloading_spec('', offloading_spec, offloading_spec.blocks_per_chunk,
                                                 parallel_agnostic=True)
        config = json.dumps([release_id, mapper.get_run_config()], sort_keys=True).encode()
        self.namespace = hashlib.sha256(config).digest()
        self.client = RamClient('/run/b70-prefix-ram/' + SOCKET_NAME)
        try:
            self.previous = self.client.index()
        except OSError:
            self.previous = set()
        self.chunk_size = primary_kv_view.strides[0]
        self.view = primary_kv_view.cast('B')
        self.pool = DualQueueThreadPool(1, 1, thread_name_prefix='switch_ram')
        self.jobs = {}
        self.results = deque()
        self.pending_store_bytes = 0

    def key(self, key):
        return hashlib.sha256(self.namespace + key).digest()

    def lookup(self, key, req_context):
        return LookupResult.HIT if self.key(key) in self.previous else LookupResult.MISS

    def on_new_request(self, req_context):
        return RequestOffloadingContext()

    def submit_load(self, job_metadata):
        self._submit(job_metadata, True)

    def submit_store(self, job_metadata):
        size = len(job_metadata.keys) * self.chunk_size
        if self.pending_store_bytes + size > 2 * 1024**3:
            # Secondary warming is expendable. Bound the number of primary
            # slot sets a slow broker can pin behind the active copies.
            self.results.append(JobResult(job_metadata.job_id, False))
            return
        self.pending_store_bytes += size
        self._submit(job_metadata, False)

    def _submit(self, job, loading):
        keys = list(job.keys)
        completed = []
        self.jobs[job.job_id] = loading, keys, completed
        transfer = self.client.load if loading else self.client.store

        def copy():
            for key, chunk_id in zip(keys, job.chunk_ids, strict=True):
                offset = int(chunk_id) * self.chunk_size
                data = self.view[offset:offset + self.chunk_size]
                transfer(self.key(key), data)
                completed.append(key)

        enqueue = self.pool.enqueue_load if loading else self.pool.enqueue_store
        enqueue(job.job_id, 1, [copy])

    def get_finished_jobs(self):
        while self.results:
            yield self.results.popleft()
        for job_id, success, seconds in self.pool.get_finished():
            loading, keys, completed = self.jobs.pop(job_id)
            if loading and not success:
                self.previous.difference_update(self.key(k) for k in keys[len(completed):])
            if not loading:
                self.pending_store_bytes -= len(keys) * self.chunk_size
            yield JobResult(job_id, success, tuple(completed) if loading and not success else None,
                            seconds, len(completed) * self.chunk_size)

    def drain_jobs(self):
        self.pool.wait_idle()

    def shutdown(self):
        self.pool.shutdown(wait=True)
