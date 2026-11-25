package com.tradera.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.widget.Toast;

/**
 * Opened from Tradera's Alerts page (tradera://pair?...): saves this phone's
 * alarm link, asks Android for what a reliable alarm needs (notifications,
 * running in the background, full-screen alarms), then starts the watcher.
 * tradera://test rings a short local test; tradera://unpair turns it off.
 */
public class PairActivity extends Activity {
    private static final int REQ_NOTIFY = 7;
    private int step;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Uri data = getIntent() == null ? null : getIntent().getData();
        String host = data == null ? "" : String.valueOf(data.getHost());

        if ("test".equals(host)) {
            Ringer.start(this, "local-test-" + System.currentTimeMillis(), "Test alarm",
                    "This is how Tradera rings when price reaches your entry. Tap Stop.", null);
            finish();
            return;
        }
        if ("unpair".equals(host)) {
            AlarmPrefs.clear(this);
            WatchService.stop(this);
            Toast.makeText(this, "Tradera alarm turned off on this phone", Toast.LENGTH_LONG).show();
            finish();
            return;
        }
        if (!"pair".equals(host)) { finish(); return; }

        String base = data.getQueryParameter("h");
        String d = data.getQueryParameter("d");
        String k = data.getQueryParameter("k");
        String u = data.getQueryParameter("u");
        if (!AlarmPrefs.allowedBase(base) || d == null || !d.matches("[0-9a-f]{12}") || k == null || !k.matches("[0-9a-f]{48}")) {
            Toast.makeText(this, "That pairing link isn't valid. Try again from Tradera → Alerts.", Toast.LENGTH_LONG).show();
            finish();
            return;
        }
        if (u != null && !u.isEmpty() && !u.matches("[0-9a-f-]{36}")) { finish(); return; }
        AlarmPrefs.save(this, base.replaceAll("/+$", ""), u, d, k);
        Ringer.ensureChannels(getApplicationContext());
        next();
    }

    /** One permission at a time, then start. */
    @SuppressLint("BatteryLife")
    private void next() {
        step++;
        if (step == 1 && Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY);
            return;
        }
        if (step <= 2) {
            step = 2;
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null && !pm.isIgnoringBatteryOptimizations(getPackageName())) {
                try {
                    startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())));
                    return; // continues in onResume
                } catch (Exception ignored) { }
            }
        }
        if (step <= 3) {
            step = 3;
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (Build.VERSION.SDK_INT >= 34 && nm != null && !nm.canUseFullScreenIntent()) {
                try {
                    startActivity(new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + getPackageName())));
                    Toast.makeText(this, "Allow Tradera to show full-screen alarms", Toast.LENGTH_LONG).show();
                    return;
                } catch (Exception ignored) { }
            }
        }
        WatchService.start(this);
        Toast.makeText(this, "Tradera alarm is on. Your phone will ring for entries.", Toast.LENGTH_LONG).show();
        finish();
    }

    private boolean waitingForSettings;

    @Override
    protected void onPause() {
        super.onPause();
        waitingForSettings = step >= 2 && !isFinishing();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (waitingForSettings) { waitingForSettings = false; next(); }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == REQ_NOTIFY) next();
    }
}
