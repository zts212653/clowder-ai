/* Compiled only into the owned test artifact, never the runtime artifact. */
#include <fcntl.h>
#include <stdio.h>
#include <time.h>

typedef struct {
  unsigned map_calls, map_failures, mapped_reads, pread_calls, ended;
} ReadWindowTestStats;
static ReadWindowTestStats test_stats;
static int test_map_fail, test_read_fail, test_paused;
static unsigned test_map_limit = READ_WINDOW_MAP_LIMIT;
static char test_ready[1024], test_release[1024];
static int test_probe_active;
static dev_t test_probe_device;
static ino_t test_probe_inode;
static sqlite3_int64 test_probe_calls;
#define TEST_COUNT(field) (test_stats.field++)
#define TEST_MAP_FAIL (test_map_fail & 1)
#define TEST_UNMAP_FAIL (test_map_fail & 2)
#define TEST_READ_FAIL test_read_fail
#define TEST_MAP_LIMIT test_map_limit

/* Independent observer of underlying pread, including when the window backend
 * is inactive. It contains no mapping implementation or data-value knowledge. */
static void test_probe_read(int fd) {
  if (!test_probe_active) return;
  struct stat st;
  if (fstat(fd, &st) == 0 && st.st_dev == test_probe_device && st.st_ino == test_probe_inode)
    test_probe_calls++;
}

static void test_probe_begin(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  (void)argc; (void)argv;
  const char *path = sqlite3_db_filename(sqlite3_context_db_handle(ctx), "main");
  struct stat st;
  if (!path || stat(path, &st) != 0) { sqlite3_result_error(ctx, "test file missing", -1); return; }
  test_probe_device = st.st_dev; test_probe_inode = st.st_ino;
  test_probe_calls = 0; test_probe_active = 1; sqlite3_result_int(ctx, 1);
}

static void test_probe_end(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  (void)argc; (void)argv;
  test_probe_active = 0; sqlite3_result_int64(ctx, test_probe_calls);
}

static void test_before_copy(void) {
  if (!test_ready[0] || test_paused) return;
  test_paused = 1;
  int fd = open(test_ready, O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (fd >= 0) { (void)write(fd, "mapped", 6); close(fd); }
  struct timespec delay = {.tv_sec = 0, .tv_nsec = 1000000};
  for (unsigned i = 0; i < 2000 && access(test_release, F_OK) != 0; i++) nanosleep(&delay, NULL);
}

static void test_finished(void) { test_stats.ended++; }

static void test_control(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  (void)argc;
  memset(&test_stats, 0, sizeof(test_stats));
  test_paused = 0;
  test_map_fail = sqlite3_value_int(argv[0]);
  test_read_fail = sqlite3_value_int(argv[1]);
  const char *ready = (const char *)sqlite3_value_text(argv[2]);
  const char *release = (const char *)sqlite3_value_text(argv[3]);
  snprintf(test_ready, sizeof(test_ready), "%s", ready ? ready : "");
  snprintf(test_release, sizeof(test_release), "%s", release ? release : "");
  int limit = sqlite3_value_int(argv[4]);
  test_map_limit = limit > 0 && limit <= READ_WINDOW_MAP_LIMIT ? (unsigned)limit : READ_WINDOW_MAP_LIMIT;
  sqlite3_result_int(ctx, 1);
}

static void test_report(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  (void)argc;
  (void)argv;
  char out[512];
  snprintf(out, sizeof(out),
           "{\"mapCalls\":%u,\"mapFailures\":%u,\"mappedReads\":%u,\"preadCalls\":%u,"
           "\"ended\":%u,\"active\":%d,\"liveMappingBytes\":%zu,\"mapLimit\":%u}",
           test_stats.map_calls, test_stats.map_failures, test_stats.mapped_reads, test_stats.pread_calls,
           test_stats.ended, window.owner != NULL, window.length, test_map_limit);
  sqlite3_result_text(ctx, out, -1, SQLITE_TRANSIENT);
}

static void register_test_functions(sqlite3 *db) {
  sqlite3_create_function(db, "memory_read_window_test_probe_begin", 0, SQLITE_UTF8, NULL, test_probe_begin, NULL, NULL);
  sqlite3_create_function(db, "memory_read_window_test_probe_end", 0, SQLITE_UTF8, NULL, test_probe_end, NULL, NULL);
  sqlite3_create_function(db, "memory_read_window_test_control", 5, SQLITE_UTF8, NULL, test_control, NULL, NULL);
  sqlite3_create_function(db, "memory_read_window_test_stats", 0, SQLITE_UTF8, NULL, test_report, NULL, NULL);
}
