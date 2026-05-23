# Integration Tests

This directory contains comprehensive integration tests for the pushwork sync tool.

## Quick Start

From the project root directory:

```bash
# Run all tests with the test runner
./test/run-tests.sh

# Run specific test suites
./test/run-tests.sh clone     # Clone functionality tests
./test/run-tests.sh conflict  # CRDT conflict resolution tests
./test/run-tests.sh full      # Full integration tests
./test/run-tests.sh unit      # Unit tests
```

## Test Scripts

### 1. Test Runner (`../run-tests.sh`)

Main entry point for running all tests. Provides:

- Dependency checking
- Multiple test suite options
- Consistent output formatting
- Error handling

### 2. Full Integration Test (`full-integration-test.sh`)

Comprehensive test suite covering all major functionality:

**Features Tested:**

- ✅ Help commands for all CLI commands
- ✅ Init with default and custom sync servers
- ✅ Clone with default and custom sync servers
- ✅ Status, diff, commit, and sync operations
- ✅ Error handling and parameter validation
- ✅ File operations (create, modify, delete)
- ✅ Bidirectional sync scenarios

**Test Sections:**

1. Help Commands - Verify all --help options work
2. Init Functionality - Test directory initialization
3. Status Functionality - Test status reporting
4. Commit Functionality - Test local commits
5. Sync Functionality - Test sync operations
6. Diff Functionality - Test change detection
7. Clone Functionality - Test cloning repositories
8. Bidirectional Sync - Test multi-directory sync
9. File Operations - Test various file types and operations

### 3. Clone Test (`clone-test.sh`)

Focused test suite specifically for clone functionality:

**Features Tested:**

- ✅ Clone with default sync server settings
- ✅ Clone with custom sync server and storage ID
- ✅ Parameter validation (sync server options must be used together)
- ✅ Force overwrite functionality
- ✅ Configuration verification in cloned repositories
- ✅ Error handling for invalid scenarios
- ✅ Status and diff operations in cloned directories

**Test Sections:**

1. Clone Functionality - All clone scenarios
2. Cloned Directory Status - Operations in cloned repos
3. Configuration Comparison - Verify settings propagation

### 4. CRDT Conflict Resolution Test (`conflict-resolution-test.sh`)

Specialized test demonstrating pushwork's excellent CRDT-based conflict resolution capabilities:

**Features Tested:**

- ✅ Create repository with initial document
- ✅ Clone repository to second location
- ✅ Make simultaneous conflicting edits on both sides
- ✅ Verify CRDT text merging preserves ALL changes
- ✅ Validate that no data is lost during conflicts
- ✅ Confirm true collaborative editing capabilities

**Test Scenario:**

1. Alice creates a document with baseline content
2. Bob clones Alice's repository
3. Both users make different additions to the same file simultaneously
4. Alice syncs her changes first
5. Bob syncs his changes (CRDT merging occurs)
6. Final sync rounds ensure eventual consistency
7. **Result**: Bob's repository contains BOTH Alice's AND Bob's changes
8. **Demonstrates**: True CRDT collaborative editing without data loss

**Key Findings:**

- ✅ Pushwork uses character-level CRDT text merging
- ✅ Both users' contributions are preserved automatically
- ✅ No manual conflict resolution required
- ✅ Immediate convergence to consistent state
- ✅ Sync timing issue has been resolved
- Repositories eventually converge to consistent state

### Deterministic Local-Relay Harness

A seeded `fast-check` harness for distributed-system probing. It spawns an
in-process Automerge sync relay (`test/helpers/local-relay-server.ts`)
on a freshly-allocated localhost port and drives the built `pushwork`
CLI against it, so each run is self-contained and does not depend on any
public sync server or machine-specific path.

```bash
pnpm run test:deterministic-harness
pnpm run test:deterministic-probe
```

- `test:deterministic-harness` runs a `fast-check` workload against a per-run local relay and reports the shrunk counterexample when convergence fails.
- `test:deterministic-probe` is a focused repro for stale existing-workspace remote visibility.
- Use `PUSHWORK_FC_SEED` and `PUSHWORK_FC_PATH` to replay a shrunk failing harness case.
- Use `PUSHWORK_FC_REPLAY='{"repoAOperations":[...],"repoBOperations":[...]}'` to replay the exact minimized operation trace emitted by a failing run.
- The harness sandboxes `HOME`/`USERPROFILE`/`XDG_CONFIG_HOME` to a per-run temp directory so ambient `~/.pushwork/config.json` does not leak into test cases.

## Test Configuration

### Required Dependencies

- **Node.js** - For running pushwork CLI
- **npm** - For building the project

### Optional Dependencies

- **jq** - For advanced JSON parsing in configuration tests (tests will be skipped if not available)

Install jq (optional):

```bash
# macOS
brew install jq

# Ubuntu/Debian
sudo apt-get install jq

# Other platforms
# See: https://stedolan.github.io/jq/download/
```

### Test Environment

- Tests run in isolated temporary directories
- Automatic cleanup on completion
- No modification of project files
- Safe to run multiple times

### Test Parameters

```bash
# Default test configuration
TEST_DIR="/tmp/pushwork-*-test"
CUSTOM_SYNC_SERVER="ws://localhost:3030"
CUSTOM_STORAGE_ID="1d89eba7-f7a4-4e8e-80f2-5f4e2406f507"
```

## Understanding Test Output

### Log Levels

- 🔵 **[INFO]** - General information
- 🟡 **[TEST]** - Test being executed
- 🟢 **[PASS]** - Test passed
- 🔴 **[FAIL]** - Test failed
- 🟡 **[WARN]** - Warning (non-critical)

### Test Results

Each test script provides a summary:

```
======================================
Test Results Summary
======================================
Tests Run:    45
Tests Passed: 43
Tests Failed: 2
```

## Running Individual Tests

### Full Integration Test

```bash
./test/integration/full-integration-test.sh
```

### Clone Test

```bash
./test/integration/clone-test.sh
```

### With Verbose Output

```bash
# Remove `> /dev/null 2>&1` redirections in scripts for verbose output
# Or modify the log functions to always show output
```

## Test Coverage

### ✅ Covered Functionality

- All CLI commands and help output
- Directory initialization (init)
- Repository cloning (clone) - **NEW**
- Sync operations (sync, status, diff, commit)
- Parameter validation
- Error handling for common scenarios
- File operations and change detection
- Configuration management
- Custom sync server support - **NEW**

### ⚠️ Known Limitations

- Network sync requires actual connectivity
- Some tests skip when dependencies missing (jq)
- Limited testing of concurrent operations
- Performance testing not included

## Troubleshooting

### Common Issues

**"jq: command not found"**

```bash
# Install jq (see dependencies section above)
brew install jq  # macOS
```

**"Permission denied"**

```bash
# Make scripts executable
chmod +x test/integration/*.sh
chmod +x test/run-tests.sh
```

**"Not in project directory"**

```bash
# Run from project root where package.json exists
cd /path/to/pushwork
./test/run-tests.sh
```

**Tests failing unexpectedly**

```bash
# Check if project builds
npm run build

# Check if CLI works
node dist/cli.js --help
```

### Debug Mode

To see more detailed output, modify the test scripts to remove output redirection:

```bash
# Change this:
if $PUSHWORK_CMD init . > /dev/null 2>&1; then

# To this:
if $PUSHWORK_CMD init .; then
```

## Adding New Tests

### Test Script Template

```bash
#!/bin/bash
set -e

# Test configuration
TEST_DIR="/tmp/my-test"
PUSHWORK_CMD="node $(pwd)/dist/cli.js"

# Colors and logging functions
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[PASS]${NC} $1"; }
log_error() { echo -e "${RED}[FAIL]${NC} $1"; }
log_test() { echo -e "${YELLOW}[TEST]${NC} $1"; }

# Cleanup
cleanup() { rm -rf "$TEST_DIR"; }
trap cleanup EXIT

# Test logic here
setup_test_environment
run_tests
```

### Guidelines

1. Use consistent naming patterns
2. Include both positive and negative test cases
3. Test error conditions thoroughly
4. Provide clear test descriptions
5. Clean up resources properly
6. Use the established logging format

## Integration with CI/CD

These tests are designed to be run in automated environments:

```bash
# In your CI pipeline
./test/run-tests.sh full
```

Exit codes:

- `0` - All tests passed
- `1` - Some tests failed
- Non-zero - Setup or dependency errors

## Contributing

When adding new features to pushwork:

1. **Add integration tests** for new CLI commands
2. **Update existing tests** if command behavior changes
3. **Test error scenarios** - not just happy paths
4. **Document test coverage** in this README
5. **Verify tests pass** before submitting PRs

The integration tests serve as both testing and documentation for how the CLI should behave.
