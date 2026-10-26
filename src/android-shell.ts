/** Quoting for adb shell's remote POSIX shell; execFile argv isolation alone is insufficient. */
export function quoteAndroidArg(value:string){return "'"+value.replaceAll("'","'\\''")+"'"}
