// Integration-test setup. Runs before any integration spec.
//
// The suite exercises plan/quota enforcement (e.g. the bulk-import 402 gate),
// which only applies when subscriptions are enabled. The app now defaults that
// OFF, so turn enforcement on for the integration project unless the
// environment already pins it. Keeping this here (rather than in the CI
// workflow env) means the suite is self-describing and runs the same locally.
process.env.BILLING_ENABLED ||= 'true';
