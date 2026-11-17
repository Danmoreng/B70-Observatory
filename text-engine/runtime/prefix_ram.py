"""Local, optional prefix store. Only the socket name lives on a filesystem."""
import argparse
from collections import OrderedDict
from contextlib import closing
import hashlib
import mmap
import os
from pathlib import Path
import socket
import struct
import subprocess
import time

GIB = 1024**3
# Leave space for Python, socket buffers and page tables inside the 8 GiB cgroup.
PAYLOAD_LIMIT = 8 * GIB - 64 * 1024**2
MAX_CHUNK = 128 * 1024**2
MAX_ENTRIES = 4096
HEADER = struct.Struct('!c32sI')
COUNT = struct.Struct('!I')
EMPTY = bytes(32)
SOCKET_NAME = 'cache.sock'


def receive(stream, target):
    with memoryview(target) as view:
        offset = 0
        while offset < len(view):
            count = stream.recv_into(view[offset:])
            if not count:
                raise ConnectionError('Incomplete cache transfer')
            offset += count


class RamClient:
    def __init__(self, path):
        self.path = str(path)

    def request(self, op, key=EMPTY, size=0):
        stream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            stream.settimeout(3)
            stream.connect(self.path)
            stream.sendall(HEADER.pack(op, key, size))
            return stream
        except BaseException:
            stream.close()
            raise

    def index(self):
        with self.request(b'I') as stream:
            head = bytearray(COUNT.size)
            receive(stream, head)
            count, = COUNT.unpack(head)
            if count > MAX_ENTRIES:
                raise OSError('Invalid RAM index size')
            ids = bytearray(32 * count)
            receive(stream, ids)
            return {bytes(ids[i:i+32]) for i in range(0, len(ids), 32)}

    def store(self, key, data):
        with self.request(b'P', key, len(data)) as stream:
            if stream.recv(1) != b'+':
                raise OSError('RAM store unavailable')
            stream.sendall(data)
            if stream.recv(1) != b'+':
                raise OSError('Incomplete RAM store')

    def load(self, key, dest):
        with self.request(b'G', key, len(dest)) as stream:
            if stream.recv(1) != b'+':
                raise OSError('RAM block evicted')
            digest = bytearray(32)
            receive(stream, digest)
            receive(stream, dest)
            intact = hashlib.sha256(dest).digest() == digest
            stream.sendall(b'+' if intact else b'-')
        # The kernel may reclaim even a single page while the broker is sending.
        # Validate the destination before vLLM can publish the primary slot.
        if not intact:
            raise OSError('RAM block reclaimed during retention')

    def control(self, op):
        with self.request(op) as stream:
            stream.settimeout(20 if op == b'T' else 2)
            if stream.recv(1) != b'+':
                raise OSError('RAM mode change not acknowledged')

    def clear(self):
        self.control(b'C')


class RamStore:
    def __init__(self, limit=PAYLOAD_LIMIT):
        self.limit = limit
        self.used = 0
        self.entries = OrderedDict()
        self.discardable = True
        self.image_phase = True

    def discard(self, key):
        pages, _ = self.entries.pop(key)
        self.used -= len(pages)
        pages.close()

    def clear(self):
        while self.entries:
            self.discard(next(iter(self.entries)))

    def image_start(self):
        self.image_phase = True
        # The image unit can charge at most 24 GiB. Keep blocks only when the
        # whole unit limit plus 1 GiB is available AFTER accounting for them.
        if host_available() < 25 * GIB:
            self.clear()
        self.check_pressure()

    def check_pressure(self):
        if not self.entries:
            return
        available = host_available()
        if available < 5 * GIB:
            self.clear()
        elif self.image_phase and available < 10 * GIB and not self.discardable:
            # No copies or disk writes. Linux may reclaim any of these pages.
            for pages, _ in self.entries.values():
                pages.madvise(mmap.MADV_FREE)
            self.discardable = True

    def text_start(self):
        if self.discardable:
            for key, (pages, digest) in list(self.entries.items()):
                if host_available() < 19 * GIB:
                    self.clear()
                    break
                # An actual write cancels MADV_FREE for surviving pages before
                # the model loader churns the file cache. Check all bytes after
                # touching; a page already lost will have come back zero-filled.
                pages[::mmap.PAGESIZE] = pages[::mmap.PAGESIZE]
                if hashlib.sha256(pages).digest() != digest:
                    self.discard(key)
        self.discardable = False
        self.image_phase = False

    def handle(self, stream):
        header = bytearray(HEADER.size)
        receive(stream, header)
        op, key, size = HEADER.unpack(header)
        if op == b'I':
            stream.sendall(COUNT.pack(len(self.entries)) + b''.join(self.entries))
        elif op == b'C':
            self.clear()
            stream.sendall(b'+')
        elif op == b'F':
            self.image_start()
            stream.sendall(b'+')
        elif op == b'T':
            self.text_start()
            stream.sendall(b'+')
        elif op == b'G':
            entry = self.entries.get(key)
            if entry is None or len(entry[0]) != size:
                stream.sendall(b'-')
                return
            pages, digest = entry
            self.entries.move_to_end(key)
            stream.sendall(b'+' + digest)
            stream.sendall(pages)
            if stream.recv(1) == b'-':
                self.discard(key)
        elif op == b'P' and 0 < size <= min(self.limit, MAX_CHUNK):
            # Published production chunks are page-aligned. Bound actual mapped
            # pages, including the one currently being received.
            if size % mmap.PAGESIZE:
                stream.sendall(b'-')
                return
            if key in self.entries:
                self.discard(key)
            while self.used + size > self.limit or len(self.entries) >= MAX_ENTRIES:
                self.discard(next(iter(self.entries)))
            pages = mmap.mmap(-1, size, flags=mmap.MAP_PRIVATE | mmap.MAP_ANONYMOUS)
            try:
                pages.madvise(mmap.MADV_DONTDUMP)
                stream.sendall(b'+')
                receive(stream, pages)
                digest = hashlib.sha256(pages).digest()
                if self.discardable:
                    pages.madvise(mmap.MADV_FREE)
            except BaseException:
                pages.close()
                raise
            self.entries[key] = pages, digest
            self.used += size
            stream.sendall(b'+')
        else:
            stream.sendall(b'-')


def host_available():
    with open('/proc/meminfo') as source:
        return next(int(row.split()[1]) * 1024 for row in source if row.startswith('MemAvailable:'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('serve', 'image-start', 'text-start', 'clear'))
    args = parser.parse_args()
    directory = Path(os.environ['XDG_RUNTIME_DIR']) / 'b70-prefix-ram'
    path = directory / SOCKET_NAME
    if args.command != 'serve':
        client = RamClient(path)
        try:
            client.control({'clear': b'C', 'image-start': b'F', 'text-start': b'T'}[args.command])
        except OSError:
            if args.command == 'image-start':
                # Even an unhealthy broker must release ordinary text-mode pages.
                subprocess.run(['systemctl', '--user', 'stop', 'b70-prefix-ram.service'], check=False, timeout=8)
            elif args.command == 'clear':
                raise
        return
    directory.mkdir(mode=0o700, exist_ok=True)
    os.umask(0o077)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
        path.unlink(missing_ok=True)
        listener.bind(str(path))
        listener.listen(16)
        listener.settimeout(.25)
        next_check = 0.
        store = RamStore()
        try:
            while True:
                if time.monotonic() >= next_check:
                    store.check_pressure()
                    next_check = time.monotonic() + .25
                try:
                    conn, _ = listener.accept()
                except TimeoutError:
                    continue
                with closing(conn) as stream:
                    stream.settimeout(3)
                    try:
                        store.handle(stream)
                    except (OSError, MemoryError):
                        # A dead engine or abandoned store must not end the broker.
                        continue
        finally:
            store.clear()
            path.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
