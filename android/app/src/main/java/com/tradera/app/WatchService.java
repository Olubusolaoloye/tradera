package com.tradera.app;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;

/**
 * Keeps the alarm ready while Tradera is closed: asks Tradera every ~30
 * seconds (every 10 while something rings) whether an alert is ringing,
 * and rings the phone when one is.
 */
public class WatchService extends Service {
    static final String CHANNEL = "tradera_watch";
    private static final int ID = 4241;

    private HandlerThread thread;
    private Handler handler;
    private String ringingFromServer;
    private int failures;

    static void start(Context ctx) {
        if (!AlarmPrefs.paired(ctx)) return;
        Intent i = new Intent(ctx, WatchService.class);
        try {
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i); else ctx.startService(i);
        } catch (Exception ignored) {
            // Android may refuse while in the background; it starts next time the app opens.
        }
    }

    static void stop(Context ctx) {
        ctx.stopService(new Intent(ctx, WatchService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        Ringer.ensureChannels(getApplicationContext());
        thread = new HandlerThread("tradera-watch");
        thread.start();
        handler = new Handler(thread.getLooper());
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification n = watchNotification();
        try {
            if (Build.VERSION.SDK_INT >= 34) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            else startForeground(ID, n);
        } catch (Exception e) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!AlarmPrefs.paired(this)) { stopSelf(); return START_NOT_STICKY; }
        handler.removeCallbacksAndMessages(null);
        handler.post(this::check);
        return START_STICKY;
    }

    private Notification watchNotification() {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent open = PendingIntent.getActivity(this, 3, new Intent(this, LauncherActivity.class), flags);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        return b.setSmallIcon(R.drawable.ic_notification_icon)
                .setContentTitle("Tradera alarm is on")
                .setContentText("Your phone will ring when price reaches an entry.")
                .setOngoing(true)
                .setPriority(Notification.PRIORITY_MIN)
                .setContentIntent(open)
                .build();
    }

    private void check() {
        int next = 30;
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        PowerManager.WakeLock wl = pm == null ? null : pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "tradera:check");
        if (wl != null) wl.acquire(30000);
        try {
            JSONObject res = fetch(AlarmPrefs.pollUrl(this));
            Log.i("TraderaAlarm", "check-in ok: " + (res == null ? "unpaired" : (res.optJSONArray("ringing") == null ? 0 : res.optJSONArray("ringing").length()) + " ringing"));
            failures = 0;
            if (res == null) {
                // 404: this phone was unpaired (or the key changed).
                AlarmPrefs.clear(this);
                stopSelf();
                return;
            }
            next = Math.max(5, Math.min(120, res.optInt("every", 30)));
            JSONArray ringing = res.optJSONArray("ringing");
            Set<String> live = new HashSet<>();
            JSONObject first = null;
            if (ringing != null) {
                for (int i = 0; i < ringing.length(); i++) {
                    JSONObject a = ringing.optJSONObject(i);
                    if (a == null) continue;
                    String id = a.optString("id");
                    live.add(id);
                    if (first == null && !Ringer.wasStopped(id)) first = a;
                }
            }
            if (first != null) {
                String id = first.optString("id");
                if (!id.equals(Ringer.ringingId())) {
                    Ringer.start(this, id, first.optString("title", "Tradera alarm"), first.optString("body", ""), first.optJSONObject("ack"));
                    Ringer.setListener(null);
                }
                ringingFromServer = id;
            } else if (ringingFromServer != null && Ringer.isRinging() && ringingFromServer.equals(Ringer.ringingId())) {
                // Stopped somewhere else (another phone, the web app, the notification).
                Ringer.stop(this, false);
                ringingFromServer = null;
            }
        } catch (Exception e) {
            Log.w("TraderaAlarm", "check-in failed: " + e);
            failures++;
            next = Math.min(120, 15 * failures); // offline: try again soon, then back off
        } finally {
            if (wl != null && wl.isHeld()) wl.release();
            if (handler != null) handler.postDelayed(this::check, next * 1000L);
        }
    }

    private JSONObject fetch(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(15000);
        c.setRequestProperty("Accept", "application/json");
        try {
            int code = c.getResponseCode();
            if (code == 404) return null;
            if (code >= 400) throw new Exception("HTTP " + code);
            StringBuilder sb = new StringBuilder();
            try (InputStream in = c.getInputStream(); BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) sb.append(line);
            }
            return new JSONObject(sb.toString());
        } finally {
            c.disconnect();
        }
    }

    @Override
    public void onDestroy() {
        if (handler != null) handler.removeCallbacksAndMessages(null);
        if (thread != null) thread.quitSafely();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
