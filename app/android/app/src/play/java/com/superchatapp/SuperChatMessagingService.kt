package com.superchatapp

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.Arguments
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * A wake-up from the chat server through FCM (server/push). It carries only
 * the room's topic. If the app is running (and so unlocked, with its keys in
 * memory), JS fetches the new messages and shows the real notification
 * (src/push.ts). If it isn't, nothing can be decrypted until the user
 * unlocks, so this shows a plain "New message" that opens the app.
 */
class SuperChatMessagingService : FirebaseMessagingService() {
  override fun onMessageReceived(message: RemoteMessage) {
    val topic = message.from?.removePrefix("/topics/") ?: return
    val react = (application as? ReactApplication)?.reactNativeHost?.reactInstanceManager?.currentReactContext
    if (react != null && react.hasActiveReactInstance()) {
      val args = Arguments.createMap().apply { putString("topic", topic) }
      react.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit("PushWake", args)
      return
    }
    showLocked(this)
  }

  // Topic subscriptions don't need the token itself.
  override fun onNewToken(token: String) {}

  companion object {
    // The app's messages channel (src/notifications/channels.ts). The app
    // clears this notification itself once it's unlocked (PushModule.clearLocked).
    private const val CHANNEL = "superchat-messages"
    const val NID = 0x5c01

    fun showLocked(context: Context) {
      val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Messages", NotificationManager.IMPORTANCE_HIGH))
      }
      val open =
          PendingIntent.getActivity(
              context,
              0,
              Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
              PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
          )
      val n =
          NotificationCompat.Builder(context, CHANNEL)
              .setSmallIcon(R.drawable.ic_notification)
              .setContentTitle("Super Chat")
              .setContentText("New message")
              .setContentIntent(open)
              .setAutoCancel(true)
              .setPriority(NotificationCompat.PRIORITY_HIGH)
              .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
              .build()
      nm.notify(NID, n)
    }
  }
}
