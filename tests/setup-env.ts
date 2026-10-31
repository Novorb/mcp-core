// Stand-in for the credential the example integration suite reads, so the shipped examples can run
// against the echo fixture.
process.env.ECHO_UPSTREAM_TOKEN ??= 'good-fixture-token';
