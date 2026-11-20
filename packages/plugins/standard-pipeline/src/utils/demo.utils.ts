/**
 * Platform demo mode (`DEMO`), read as the host reads it (`config.demo.isEnabled()` in
 * `@ever-works/agent`): `true`, `1` or `yes`, case-insensitive, trimmed. The pipeline runs in
 * the host's process (the API or a Trigger worker), whose environment carries the switch.
 */
export function isDemoMode(): boolean {
	return ['true', '1', 'yes'].includes((process.env.DEMO ?? '').trim().toLowerCase());
}
