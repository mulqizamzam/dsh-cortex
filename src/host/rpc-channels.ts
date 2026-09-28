/** RPC channel names shared by both halves (HOST-API §5; loopback authority). */
export const CORTEX_READ_CHANNEL = '/dsh-cortex-read'
/** Declared only: the write channel arrives with a UI-issued capability token (P3). */
export const CORTEX_WRITE_CHANNEL = '/dsh-cortex-write'
/** Endpoints owned by M0. M2..M6 extend the same channels. */
export const CORTEX_PING_ENDPOINT = 'ping'
