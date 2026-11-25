package com.tradera.app;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/** The full-screen alarm, shown over the lock screen, with a big Stop button. */
public class AlarmActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
            KeyguardManager km = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
            if (km != null) km.requestDismissKeyguard(this, null);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                    | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        if (!Ringer.isRinging()) { finish(); return; }

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setPadding(dp(28), dp(48), dp(28), dp(48));
        root.setBackgroundColor(Color.parseColor("#070B14"));

        TextView label = text("TRADERA ALARM", 13, "#7DB6FF", true);
        label.setLetterSpacing(0.12f);
        TextView title = text(Ringer.title(), 30, "#EEF2F9", true);
        TextView body = text(Ringer.body(), 17, "#9CA8BD", false);
        body.setPadding(0, dp(14), 0, dp(40));

        Button stop = new Button(this);
        stop.setText("Stop");
        stop.setAllCaps(false);
        stop.setTextSize(TypedValue.COMPLEX_UNIT_SP, 24);
        stop.setTypeface(Typeface.DEFAULT_BOLD);
        stop.setTextColor(Color.WHITE);
        GradientDrawable bg = new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
                new int[]{Color.parseColor("#3F8EF7"), Color.parseColor("#1D5FD1")});
        bg.setCornerRadius(dp(40));
        stop.setBackground(bg);
        stop.setOnClickListener(v -> { Ringer.stop(this, true); finish(); });

        Button open = new Button(this);
        open.setText("Stop and open Tradera");
        open.setAllCaps(false);
        open.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        open.setTextColor(Color.parseColor("#9CA8BD"));
        open.setBackgroundColor(Color.TRANSPARENT);
        open.setOnClickListener(v -> {
            Ringer.stop(this, true);
            startActivity(new Intent(this, LauncherActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            finish();
        });

        root.addView(label);
        root.addView(title);
        root.addView(body);
        root.addView(stop, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(76)));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(56));
        lp.topMargin = dp(12);
        root.addView(open, lp);
        setContentView(root);

        Ringer.setListener(this::finish);
    }

    private TextView text(String s, int sp, String color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(Color.parseColor(color));
        t.setGravity(Gravity.CENTER);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    @Override
    public void onBackPressed() {
        // Back doesn't silence the alarm; use Stop.
    }

    @Override
    protected void onDestroy() {
        Ringer.setListener(null);
        super.onDestroy();
    }
}
