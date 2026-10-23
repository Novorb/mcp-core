// Stand-in for the operator-supplied credential the example integration suite reads. A consumer's
// operator sets the real variable; here it lets the shipped examples run against the echo fixture.
process.env.ECHO_UPSTREAM_TOKEN ??= 'good-fixture-token';
