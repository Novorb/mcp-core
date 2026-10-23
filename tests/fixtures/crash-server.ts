// Spawned by the harness tests: a "server" that fails at startup, so startup-failure paths surface stderr.
process.stderr.write('crash-fixture: refusing to start\n');
process.exit(3);
