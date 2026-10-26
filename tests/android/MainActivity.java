package com.pixelsandroid.controltest;

import android.app.Activity;
import android.os.Bundle;
import android.content.res.Configuration;
import android.content.pm.ActivityInfo;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.*;
import org.json.JSONObject;
import java.io.FileOutputStream;

/** Local-only fixture: exposes observable results of injected input in its own sandbox. */
public class MainActivity extends Activity {
    android.media.ToneGenerator audioTone;
    int clicks, longs, moves, ups, backs, scrollY;
    boolean pressed;
    String entered = "";
    float lastX, lastY;
    TextView status;
    int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    TextView label(String text, int size) { TextView view = new TextView(this); view.setText(text); view.setTextSize(size); view.setTextColor(0xffe8f0f3); return view; }
    Button button(String text, String description) { Button button = new Button(this); button.setText(text); button.setContentDescription(description); return button; }
    void save() {
        try {
            JSONObject value = new JSONObject();
            value.put("clicks", clicks); value.put("longPresses", longs); value.put("dragMoves", moves); value.put("ups", ups); value.put("pressed", pressed);
            value.put("backPresses", backs); value.put("scrollY", scrollY); value.put("text", entered); value.put("dragX", lastX); value.put("dragY", lastY);
            value.put("orientation", getResources().getConfiguration().orientation);
            try (FileOutputStream stream = openFileOutput("state.json", MODE_PRIVATE)) { stream.write(value.toString().getBytes("UTF-8")); }
            if (status != null) status.setText("点击 " + clicks + " · 长按 " + longs + " · 拖动 " + moves + " · 返回 " + backs);
        } catch (Exception error) { throw new RuntimeException(error); }
    }
    @Override public void onCreate(Bundle bundle) {
        super.onCreate(bundle);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setTurnScreenOn(true);
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setPadding(dp(12), dp(8), dp(12), dp(8)); root.setBackgroundColor(0xff102028);
        root.addView(label("Android 手机控制验收", 21));
        status = label("", 13); root.addView(status);
        LinearLayout actions = new LinearLayout(this);
        Button tap = button("点击测试", "点击测试"); tap.setOnClickListener(v -> { clicks++; save(); }); actions.addView(tap, new LinearLayout.LayoutParams(0, dp(48), 1));
        Button hold = button("长按测试", "长按测试"); hold.setOnLongClickListener(v -> { longs++; save(); return true; }); actions.addView(hold, new LinearLayout.LayoutParams(0, dp(48), 1)); root.addView(actions);
        EditText input = new EditText(this); input.setTextColor(0xffe8f0f3); input.setHintTextColor(0xff95a4ab); input.setHint("点击这里，再从电脑输入中英文"); input.setContentDescription("测试文字输入"); input.setSingleLine(false); input.setMinLines(2); input.setMaxLines(3); input.setInputType(0x00020001);
        input.addTextChangedListener(new TextWatcher() { public void beforeTextChanged(CharSequence s,int a,int c,int f) {} public void onTextChanged(CharSequence s,int a,int b,int c) { entered=s.toString(); save(); } public void afterTextChanged(Editable e) {} }); root.addView(input, new LinearLayout.LayoutParams(-1, dp(82)));
        View drag = new View(this) {
            final Paint paint = new Paint(3);
            @Override protected void onDraw(Canvas canvas) {
                canvas.drawColor(0xff163f4b); paint.setColor(0xff8ce0c3); paint.setTextSize(dp(15)); canvas.drawText("在这里按住并拖动", dp(12), dp(28), paint);
                if (moves > 0 || pressed) { paint.setColor(0xffe5ba73); canvas.drawCircle(lastX,lastY,dp(10),paint); }
            }
            @Override public boolean onTouchEvent(MotionEvent event) {
                lastX=event.getX(); lastY=event.getY();
                if (event.getActionMasked()==MotionEvent.ACTION_DOWN) pressed=true;
                if (event.getActionMasked()==MotionEvent.ACTION_MOVE) moves++;
                if (event.getActionMasked()==MotionEvent.ACTION_UP || event.getActionMasked()==MotionEvent.ACTION_CANCEL) { pressed=false; ups++; }
                save(); invalidate(); return true;
            }
        }; drag.setContentDescription("拖动测试区域"); root.addView(drag, new LinearLayout.LayoutParams(-1, dp(110)));
        Button rotate = button("切换横竖屏", "切换横竖屏"); rotate.setOnClickListener(v -> setRequestedOrientation(getResources().getConfiguration().orientation == Configuration.ORIENTATION_PORTRAIT ? ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE : ActivityInfo.SCREEN_ORIENTATION_PORTRAIT)); root.addView(rotate, new LinearLayout.LayoutParams(-1, dp(44)));
        Button tone = button("播放验收声音", "播放验收声音"); tone.setOnClickListener(v -> { if (audioTone != null) audioTone.release(); audioTone = new android.media.ToneGenerator(android.media.AudioManager.STREAM_MUSIC, 15); audioTone.startTone(android.media.ToneGenerator.TONE_DTMF_1, 8000); }); root.addView(tone, new LinearLayout.LayoutParams(-1, dp(44)));
        ScrollView scroll = new ScrollView(this); scroll.setContentDescription("滚动测试列表"); LinearLayout rows = new LinearLayout(this); rows.setOrientation(LinearLayout.VERTICAL);
        for (int i=1;i<=60;i++) { TextView row = label("列表条目 " + i,16); row.setPadding(dp(8), dp(8), dp(8), dp(8)); rows.addView(row); }
        scroll.addView(rows); scroll.setOnScrollChangeListener((v,x,y,oldX,oldY) -> { scrollY=y; save(); }); root.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
        setContentView(root); save();
    }
    @Override public void onBackPressed() { backs++; save(); }
    @Override public void onDestroy() { if (audioTone != null) audioTone.release(); super.onDestroy(); }
    @Override public void onConfigurationChanged(Configuration configuration) { super.onConfigurationChanged(configuration); save(); }
}
