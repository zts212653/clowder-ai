#include <node_api.h>
#include <libproc.h>
#include <mach/mach.h>
#include <mach/mach_time.h>
#include <pthread.h>
#include <sys/sysctl.h>
#include <unistd.h>
#include <errno.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <ctype.h>

/* Same-process kernel counters only. No task_for_pid, suspension, Inspector,
 * thread names, command lines, environment or business data. */
#define THREAD_LIMIT 64
static napi_value object(napi_env e) {
  napi_value v; napi_create_object(e, &v); return v;
}
static void number(napi_env e, napi_value o, const char *key, double n) {
  napi_value v; napi_create_double(e, n, &v); napi_set_named_property(e, o, key, v);
}
static void text(napi_env e, napi_value o, const char *key, const char *s) {
  napi_value v; napi_create_string_utf8(e, s, NAPI_AUTO_LENGTH, &v); napi_set_named_property(e, o, key, v);
}
static void property(napi_env e, napi_value o, const char *key, napi_value v) {
  napi_set_named_property(e, o, key, v);
}
static double ms(uint64_t ns) { return (double)(ns / 1000) / 1000; }
static napi_value identifier(napi_env e, uint64_t id) {
  char s[32]; snprintf(s, sizeof(s), "%" PRIu64, id);
  napi_value v; napi_create_string_utf8(e, s, NAPI_AUTO_LENGTH, &v); return v;
}
static napi_value current_thread_id(napi_env e, napi_callback_info cb) {
  (void)cb;
  uint64_t id = 0;
  if (pthread_threadid_np(NULL, &id) != 0) {
    napi_throw_error(e, NULL, "thread_identity_unavailable"); return NULL;
  }
  return identifier(e, id);
}
static napi_value thread_counters(napi_env e, const struct proc_threadinfo *info) {
  napi_value result = object(e);
  number(e, result, "userMs", ms(info->pth_user_time));
  number(e, result, "systemMs", ms(info->pth_system_time));
  number(e, result, "runState", info->pth_run_state);
  number(e, result, "priority", info->pth_curpri);
  number(e, result, "sleepSeconds", info->pth_sleep_time);
  return result;
}
static napi_value snapshot(napi_env e, napi_callback_info cb) {
  if (pthread_main_np()) {
    napi_throw_error(e, NULL, "process_witness_requires_worker"); return NULL;
  }
  size_t argc = 1, size = 0;
  napi_value argv[1]; char id_text[32] = {0};
  napi_get_cb_info(e, cb, &argc, argv, NULL, NULL);
  if (argc != 1 || napi_get_value_string_utf8(e, argv[0], id_text, sizeof(id_text), &size) != napi_ok ||
      size == 0 || size >= sizeof(id_text) - 1) {
    napi_throw_error(e, NULL, "invalid_main_thread_identity"); return NULL;
  }
  char *end = NULL; errno = 0;
  for (size_t i = 0; i < size; i++) if (!isdigit((unsigned char)id_text[i])) {
    napi_throw_error(e, NULL, "invalid_main_thread_identity"); return NULL;
  }
  uint64_t main_id = strtoull(id_text, &end, 10);
  if (errno || !main_id || !end || *end) {
    napi_throw_error(e, NULL, "invalid_main_thread_identity"); return NULL;
  }
  napi_value result = object(e);
  uint64_t collector_id = 0; pthread_threadid_np(NULL, &collector_id);
  property(e, result, "mainThreadId", identifier(e, main_id));
  property(e, result, "collectorThreadId", identifier(e, collector_id));
  struct proc_taskinfo task = {0};
  struct proc_threadinfo main = {0};
  if (proc_pidinfo(getpid(), PROC_PIDTASKINFO, 0, &task, sizeof(task)) != sizeof(task) ||
      proc_pidinfo(getpid(), PROC_PIDTHREADID64INFO, main_id, &main, sizeof(main)) != sizeof(main)) {
    napi_throw_error(e, NULL, "process_counters_unavailable"); return NULL;
  }
  property(e, result, "mainThread", thread_counters(e, &main));
  napi_value proc = object(e);
  /* Task totals are Mach absolute ticks; pth_* times above are nanoseconds.
   * They differ by 125/3 on this Apple Silicon host. Never label ticks as ns. */
  mach_timebase_info_data_t clock = {0};
  if (mach_timebase_info(&clock) != KERN_SUCCESS || !clock.denom) {
    napi_throw_error(e, NULL, "task_cpu_clock_unavailable"); return NULL;
  }
  number(e, proc, "userMs", (double)task.pti_total_user / clock.denom * clock.numer / 1000000);
  number(e, proc, "systemMs", (double)task.pti_total_system / clock.denom * clock.numer / 1000000);
  number(e, proc, "faults", task.pti_faults);
  number(e, proc, "pageins", task.pti_pageins);
  number(e, proc, "cowFaults", task.pti_cow_faults);
  number(e, proc, "contextSwitches", task.pti_csw);
  number(e, proc, "residentBytes", task.pti_resident_size);
  number(e, proc, "threadCount", task.pti_threadnum);
  number(e, proc, "runnableThreads", task.pti_numrunning);
  property(e, result, "process", proc);
  /* LISTTHREADS exposes opaque pthread handles, not kernel thread ids. Use
   * THREADID64INFO above for the positively identified main OS thread. */
  uint64_t handles[THREAD_LIMIT] = {0};
  int bytes = proc_pidinfo(getpid(), PROC_PIDLISTTHREADS, 0, handles, sizeof(handles));
  if (bytes <= 0 || bytes > (int)sizeof(handles) || bytes % sizeof(uint64_t)) {
    napi_throw_error(e, NULL, "thread_list_unavailable"); return NULL;
  }
  napi_value threads; napi_create_array(e, &threads);
  int count = bytes / sizeof(uint64_t), missing = 0, written = 0;
  for (int i = 0; i < count; i++) {
    struct proc_threadinfo info = {0};
    if (proc_pidinfo(getpid(), PROC_PIDTHREADINFO, handles[i], &info, sizeof(info)) != sizeof(info)) {
      missing++; continue; /* A thread may exit during the non-atomic read. */
    }
    napi_value row = thread_counters(e, &info);
    property(e, row, "handle", identifier(e, handles[i]));
    napi_set_element(e, threads, written++, row);
  }
  property(e, result, "threads", threads);
  number(e, result, "missingThreads", missing);
  number(e, result, "omittedThreads", task.pti_threadnum > count ? task.pti_threadnum - count : 0);
  napi_value host = object(e);
  int pressure = 0; size_t pressure_size = sizeof(pressure);
  if (sysctlbyname("kern.memorystatus_vm_pressure_level", &pressure, &pressure_size, NULL, 0) == 0)
    number(e, host, "memoryPressure", pressure);
  else text(e, host, "memoryPressureError", "sysctl_unavailable");
  struct xsw_usage swap = {0}; size_t swap_size = sizeof(swap);
  if (sysctlbyname("vm.swapusage", &swap, &swap_size, NULL, 0) == 0)
    number(e, host, "swapUsedBytes", swap.xsu_used);
  else text(e, host, "swapUsageError", "sysctl_unavailable");
  host_t host_port = mach_host_self();
  vm_statistics64_data_t vm = {0}; mach_msg_type_number_t vm_count = HOST_VM_INFO64_COUNT;
  if (host_statistics64(host_port, HOST_VM_INFO64, (host_info64_t)&vm, &vm_count) == KERN_SUCCESS) {
    number(e, host, "compressorPages", vm.compressor_page_count);
    number(e, host, "compressions", vm.compressions);
    number(e, host, "decompressions", vm.decompressions);
    number(e, host, "swapins", vm.swapins);
    number(e, host, "swapouts", vm.swapouts);
    number(e, host, "pageins", vm.pageins);
    number(e, host, "pageouts", vm.pageouts);
    number(e, host, "pageSize", vm_page_size);
  } else text(e, host, "vmError", "host_statistics_unavailable");
  host_cpu_load_info_data_t cpu = {0}; mach_msg_type_number_t cpu_count = HOST_CPU_LOAD_INFO_COUNT;
  if (host_statistics(host_port, HOST_CPU_LOAD_INFO, (host_info_t)&cpu, &cpu_count) == KERN_SUCCESS) {
    number(e, host, "cpuUserTicks", cpu.cpu_ticks[CPU_STATE_USER]);
    number(e, host, "cpuSystemTicks", cpu.cpu_ticks[CPU_STATE_SYSTEM]);
    number(e, host, "cpuIdleTicks", cpu.cpu_ticks[CPU_STATE_IDLE]);
    number(e, host, "cpuNiceTicks", cpu.cpu_ticks[CPU_STATE_NICE]);
  } else text(e, host, "cpuError", "host_statistics_unavailable");
  mach_port_deallocate(mach_task_self(), host_port);
  property(e, result, "host", host);
  return result;
}
static napi_value initialize(napi_env e, napi_value exports) {
  napi_property_descriptor functions[] = {
    {"currentThreadId", NULL, current_thread_id, NULL, NULL, NULL, napi_default, NULL},
    {"snapshot", NULL, snapshot, NULL, NULL, NULL, napi_default, NULL},
  };
  napi_define_properties(e, exports, 2, functions); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
