package com.tradera.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** "Stop alarm" from the notification, and restarting the watcher after a reboot or update. */
public class AlarmReceiver extends BroadcastReceiver {
    static final String ACTION_STOP = "com.tradera.app.STOP_ALARM";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            Ringer.stop(context, true);
            return;
        }
        if (Intent.ACTION_BOOT_COMPLETED.equals(action) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            WatchService.start(context);
        }
    }
}
