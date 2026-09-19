// Slots in the SharedArrayBuffer shared by the rail writer (main thread) and the spinner worker.
export const S = { LOCK: 0, RUNNING: 1, GENERATION: 2, AT_LINE_START: 3, SHOWN: 4, PAUSED: 5, QUIT: 6 };
export const SIZE = 8;
