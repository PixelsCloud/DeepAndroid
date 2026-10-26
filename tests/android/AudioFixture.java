package com.pixelsandroid.controltest;
/** Short-lived shell test process. Does not install an app or change phone settings. */
public final class AudioFixture {
    public static void main(String[] args) throws Exception {
        android.os.Looper.prepare();
        android.media.ToneGenerator tone = new android.media.ToneGenerator(android.media.AudioManager.STREAM_MUSIC, 15);
        try { tone.startTone(android.media.ToneGenerator.TONE_DTMF_1, 4000); Thread.sleep(4300); }
        finally { tone.release(); }
    }
}
