package com.tradera.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Rings the phone like an alarm clock: the alarm sound on the alarm channel
 * (which plays in silent mode), at full alarm volume, looping, with
 * continuous vibration and a full-screen alarm, until Stop.
 */
final class Ringer {
    static final String CHANNEL = "tradera_alarm";
    static final int NOTIFICATION_ID = 4242;
    static final long MAX_RING_MS = 10 * 60 * 1000L;

    interface Listener { void onStopped(); }

    private static MediaPlayer player;
    private static String ringingId;
    private static String title = "Tradera alarm";
    private static String body = "";
    private static JSONObject ack;
    private static Integer savedVolume;
    private static PowerManager.WakeLock wakeLock;
    private static Listener listener;
    private static final Handler main = new Handler(Looper.getMainLooper());
    private static final java.util.Set<String> stoppedIds = new java.util.HashSet<>();

    private Ringer() {}

    static synchronized boolean isRinging() { return player != null; }
    static synchronized String ringingId() { return ringingId; }
    static synchronized String title() { return title; }
    static synchronized String body() { return body; }
    static synchronized void setListener(Listener l) { listener = l; }
    static synchronized boolean wasStopped(String id) { return id != null && stoppedIds.contains(id); }

    static synchronized void start(Context ctx, String id, String t, String b, JSONObject ackInfo) {
        Context app = ctx.getApplicationContext();
        if (player != null && id != null && id.equals(ringingId)) return;
        stopSound(app);
        ringingId = id;
        title = t == null ? "Tradera alarm" : t;
        body = b == null ? "" : b;
        ack = ackInfo;

        PowerManager pm = (PowerManager) app.getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "tradera:alarm");
            wakeLock.acquire(MAX_RING_MS + 5000);
        }

        // Full alarm volume while ringing; put it back afterwards.
        AudioManager am = (AudioManager) app.getSystemService(Context.AUDIO_SERVICE);
        if (am != null) {
            try {
                savedVolume = am.getStreamVolume(AudioManager.STREAM_ALARM);
                am.setStreamVolume(AudioManager.STREAM_ALARM, am.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0);
            } catch (SecurityException ignored) {
                savedVolume = null;
            }
        }

        Uri sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
        if (sound == null) sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        if (sound == null) sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
        try {
            MediaPlayer mp = new MediaPlayer();
            mp.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build());
            mp.setDataSource(app, sound);
            mp.setLooping(true);
            mp.prepare();
            mp.start();
            player = mp;
        } catch (Exception e) {
            player = new MediaPlayer(); // keep "ringing" state so the alarm screen and vibration still work
        }

        vibrate(app);
        showAlarmNotification(app);
        main.removeCallbacksAndMessages(null);
        main.postDelayed(() -> stop(app, false), MAX_RING_MS);
    }

    /** Stop ringing; tell Tradera when the user pressed Stop here. */
    static synchronized void stop(Context ctx, boolean sendAck) {
        Context app = ctx.getApplicationContext();
        JSONObject a = ack;
        if (ringingId != null) {
            if (stoppedIds.size() > 50) stoppedIds.clear();
            stoppedIds.add(ringingId);
        }
        stopSound(app);
        main.removeCallbacksAndMessages(null);
        if (sendAck && a != null) sendAck(app, a);
        Listener l = listener;
        if (l != null) main.post(l::onStopped);
    }

    private static void stopSound(Context app) {
        if (player != null) {
            try { player.stop(); } catch (Exception ignored) { }
            try { player.release(); } catch (Exception ignored) { }
            player = null;
        }
        Vibrator v = vibrator(app);
        if (v != null) v.cancel();
        AudioManager am = (AudioManager) app.getSystemService(Context.AUDIO_SERVICE);
        if (am != null && savedVolume != null) {
            try { am.setStreamVolume(AudioManager.STREAM_ALARM, savedVolume, 0); } catch (SecurityException ignored) { }
        }
        savedVolume = null;
        NotificationManager nm = (NotificationManager) app.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(NOTIFICATION_ID);
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
        ringingId = null;
        ack = null;
    }

    private static Vibrator vibrator(Context app) {
        if (Build.VERSION.SDK_INT >= 31) {
            VibratorManager vm = (VibratorManager) app.getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
            return vm == null ? null : vm.getDefaultVibrator();
        }
        return (Vibrator) app.getSystemService(Context.VIBRATOR_SERVICE);
    }

    private static void vibrate(Context app) {
        Vibrator v = vibrator(app);
        if (v == null || !v.hasVibrator()) return;
        long[] pattern = {0, 900, 400, 900, 400, 1400, 600};
        if (Build.VERSION.SDK_INT >= 26) {
            AudioAttributes attrs = new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build();
            v.vibrate(VibrationEffect.createWaveform(pattern, 0), attrs);
        } else {
            v.vibrate(pattern, 0);
        }
    }

    static void ensureChannels(Context app) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) app.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel alarm = new NotificationChannel(CHANNEL, "Alarms for entries", NotificationManager.IMPORTANCE_HIGH);
        alarm.setDescription("Rings loudly when price reaches your entry.");
        alarm.setSound(null, null); // the alarm plays its own looping sound
        alarm.enableVibration(false);
        alarm.setBypassDnd(true);
        alarm.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(alarm);
        NotificationChannel watch = new NotificationChannel(WatchService.CHANNEL, "Watching your alerts", NotificationManager.IMPORTANCE_MIN);
        watch.setDescription("Keeps the alarm ready while Tradera is closed.");
        watch.setShowBadge(false);
        nm.createNotificationChannel(watch);
    }

    private static void showAlarmNotification(Context app) {
        ensureChannels(app);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        Intent full = new Intent(app, AlarmActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_USER_ACTION);
        PendingIntent fullPi = PendingIntent.getActivity(app, 1, full, flags);
        PendingIntent stopPi = PendingIntent.getBroadcast(app, 2,
                new Intent(app, AlarmReceiver.class).setAction(AlarmReceiver.ACTION_STOP), flags);
        Notification.Builder nb = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(app, CHANNEL) : new Notification.Builder(app);
        nb.setSmallIcon(R.drawable.ic_notification_icon)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setCategory(Notification.CATEGORY_ALARM)
                .setPriority(Notification.PRIORITY_MAX)
                .setOngoing(true)
                .setAutoCancel(false)
                .setFullScreenIntent(fullPi, true)
                .setContentIntent(fullPi)
                .addAction(new Notification.Action.Builder(null, "Stop alarm", stopPi).build());
        NotificationManager nm = (NotificationManager) app.getSystemService(Context.NOTIFICATION_SERVICE);
        try { if (nm != null) nm.notify(NOTIFICATION_ID, nb.build()); } catch (SecurityException ignored) { }
        // Also open the alarm screen straight away when the phone allows it.
        try { app.startActivity(full); } catch (Exception ignored) { }
    }

    private static void sendAck(Context app, JSONObject a) {
        final String base = AlarmPrefs.base(app);
        if (base.isEmpty()) return;
        new Thread(() -> {
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(base + "/api/push/ack").openConnection();
                c.setRequestMethod("POST");
                c.setConnectTimeout(15000);
                c.setReadTimeout(15000);
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                byte[] out = a.toString().getBytes(StandardCharsets.UTF_8);
                try (OutputStream os = c.getOutputStream()) { os.write(out); }
                c.getResponseCode();
            } catch (Exception ignored) {
                // Opening Tradera stops it on the server too.
            } finally {
                if (c != null) c.disconnect();
            }
        }).start();
    }
}
