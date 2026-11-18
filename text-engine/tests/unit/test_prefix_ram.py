"""Exercise the host protocol, retention bound and lost-page integrity check."""
import mmap
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'runtime'))
from prefix_ram import GIB, RamClient, RamStore


class RamProtocol(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        path = self.directory.name + '/cache.sock'
        self.client = RamClient(path)
        self.store = RamStore(2 * mmap.PAGESIZE)
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.listener.bind(path)
        self.listener.listen()
        self.done = threading.Event()
        self.listener.settimeout(0.1)
        self.worker = threading.Thread(target=self.serve)
        self.worker.start()

    def serve(self):
        while not self.done.is_set():
            try:
                stream, _ = self.listener.accept()
            except TimeoutError:
                continue
            with stream:
                try:
                    self.store.handle(stream)
                except ConnectionError:
                    pass

    def tearDown(self):
        self.done.set()
        self.worker.join(3)
        self.listener.close()
        self.store.clear()
        self.directory.cleanup()

    def test_bound_lru_and_clear(self):
        data = b'a' * mmap.PAGESIZE
        a, b, c = (bytes([i]) * 32 for i in (1, 2, 3))
        self.client.store(a, data)
        self.client.store(b, data)
        dest = bytearray(len(data))
        self.client.load(a, dest)
        self.assertEqual(dest, data)
        self.client.store(c, data)
        self.assertEqual(self.client.index(), {a, c})
        self.assertEqual(self.store.used, self.store.limit)
        self.client.clear()
        self.assertEqual(self.client.index(), set())
        self.assertEqual(self.store.used, 0)

    def test_partially_reclaimed_chunk_is_never_returned_as_a_hit(self):
        key = b'k' * 32
        data = b'x' * (2 * mmap.PAGESIZE)
        self.client.store(key, data)
        pages, _ = self.store.entries[key]
        pages.madvise(mmap.MADV_DONTNEED, mmap.PAGESIZE, mmap.PAGESIZE)
        with self.assertRaisesRegex(OSError, 'reclaimed'):
            self.client.load(key, bytearray(len(data)))

    def test_image_admission_and_runtime_pressure(self):
        data = b'p' * mmap.PAGESIZE
        key = b'p' * 32
        with patch('prefix_ram.host_available', return_value=27 * GIB):
            self.client.control(b'T')
            self.client.store(key, data)
            self.client.control(b'F')
            self.assertFalse(self.store.discardable)
        with patch('prefix_ram.host_available', return_value=6 * GIB):
            self.store.check_pressure()
            self.assertTrue(self.store.discardable)
        with patch('prefix_ram.host_available', return_value=4 * GIB):
            self.store.check_pressure()
            self.assertFalse(self.client.index())
        with patch('prefix_ram.host_available', return_value=23 * GIB):
            self.client.store(key, data)
            self.client.control(b'F')
            self.assertFalse(self.client.index())

    def test_moderate_release_limits_bytes_per_poll_even_if_pressure_persists(self):
        a, b = b'a' * 32, b'b' * 32
        for key in (a, b):
            self.client.store(key, b'x' * mmap.PAGESIZE)
        with patch('prefix_ram.host_available', return_value=9 * GIB):
            self.store.release_until_available(11 * GIB, max_bytes=mmap.PAGESIZE)
        self.assertEqual(self.client.index(), {b})

    def test_transient_image_pressure_frees_oldest_complete_block(self):
        a, b = b'a' * 32, b'b' * 32
        with patch('prefix_ram.host_available', return_value=27 * GIB):
            self.client.control(b'T')
            for key in (a, b):
                self.client.store(key, b'x' * mmap.PAGESIZE)
            self.client.control(b'F')
        with patch('prefix_ram.host_available', side_effect=[9 * GIB, 9 * GIB, 11 * GIB]):
            self.store.check_pressure()
        self.assertEqual(self.client.index(), {b})
        self.assertFalse(self.store.discardable)

    def test_image_start_preserves_newer_blocks_once_headroom_recovers(self):
        data = b'p' * mmap.PAGESIZE
        a, b = b'a' * 32, b'b' * 32
        self.client.store(a, data)
        self.client.store(b, data)
        with patch('prefix_ram.host_available', side_effect=[24 * GIB, 25 * GIB, 25 * GIB]):
            self.client.control(b'F')
        self.assertEqual(self.client.index(), {b})

    def test_interrupted_write_is_never_published(self):
        key = b'i' * 32
        with self.client.request(b'P', key, mmap.PAGESIZE) as stream:
            self.assertEqual(stream.recv(1), b'+')
            stream.sendall(b'incomplete')
        self.assertEqual(self.client.index(), set())
        self.assertEqual(self.store.used, 0)


if __name__ == '__main__':
    unittest.main()
