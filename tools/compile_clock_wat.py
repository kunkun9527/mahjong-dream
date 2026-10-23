"""Development-only native WAT compilation and Unity-compatible Brotli metadata.

Requires wasmtime==50.0.1 and brotlicffi==1.2.0.0.
"""
from pathlib import Path
import sys
import wasmtime
import brotlicffi

wasm = bytes(wasmtime.wat2wasm(Path(sys.argv[1]).read_bytes()))
output = Path(sys.argv[2])
output.write_bytes(wasm)
compressor = brotlicffi.Compressor(quality=9)
# Brotli C API operation 3 emits a metadata block; the pinned wrapper does not
# expose it publicly. Let the mature encoder write the header/bitstream.
marker = compressor._compress(b"UnityWeb Compressed Content (brotli)", 3)
Path(str(output) + ".br").write_bytes(marker + compressor.compress(wasm) + compressor.finish())
