"""Read the macOS public libproc rusage v0 counters for supplied test PIDs."""
import ctypes
import json
import sys


class Rusage(ctypes.Structure):
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [(name, ctypes.c_uint64) for name in (
        "user_time", "system_time", "pkg_idle_wkups", "interrupt_wkups", "pageins",
        "wired_size", "resident_size", "phys_footprint", "proc_start", "proc_exit")]


lib = ctypes.CDLL("/usr/lib/libproc.dylib")
lib.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
lib.proc_pid_rusage.restype = ctypes.c_int
result = []
for argument in sys.argv[1:]:
    pid = int(argument)
    usage = Rusage()
    if lib.proc_pid_rusage(pid, 0, ctypes.byref(usage)) == 0:
        result.append({"pid": pid, "footprintBytes": usage.phys_footprint,
                       "residentBytes": usage.resident_size,
                       "cpuTime": usage.user_time + usage.system_time})
print(json.dumps(result))
