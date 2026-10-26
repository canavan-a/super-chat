package com.superchatapp

import android.content.Context
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.uimanager.ViewManager
import com.google.firebase.messaging.FirebaseMessaging

/**
 * FCM for the Google Play build (src/push.ts). The device subscribes itself
 * to each of its rooms' topics, so the chat server never sees a device
 * token; wake-ups arrive in SuperChatMessagingService.
 */
class PushModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  override fun getName() = "Push"

  /** False without Google Play services (e.g. GrapheneOS without sandboxed Play). */
  @ReactMethod
  fun isAvailable(promise: Promise) {
    val available =
        try {
          context.packageManager.getPackageInfo("com.google.android.gms", 0)
          true
        } catch (e: Exception) {
          false
        }
    promise.resolve(available)
  }

  @ReactMethod
  fun subscribe(topic: String, promise: Promise) {
    FirebaseMessaging.getInstance().subscribeToTopic(topic).addOnCompleteListener {
      if (it.isSuccessful) {
        setTopic(context, topic, true)
        promise.resolve(null)
      } else {
        promise.reject("push", it.exception?.message ?: "subscribe failed")
      }
    }
  }

  @ReactMethod
  fun unsubscribe(topic: String, promise: Promise) {
    FirebaseMessaging.getInstance().unsubscribeFromTopic(topic).addOnCompleteListener {
      if (it.isSuccessful) {
        setTopic(context, topic, false)
        promise.resolve(null)
      } else {
        promise.reject("push", it.exception?.message ?: "unsubscribe failed")
      }
    }
  }

  /** Removes the plain "New message" shown while the app was closed. */
  @ReactMethod
  fun clearLocked() {
    val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
    nm.cancel(SuperChatMessagingService.NID)
  }

  /** Shows the plain "New message": a wake-up JS couldn't turn into the real notification. */
  @ReactMethod
  fun showLocked() {
    SuperChatMessagingService.showLocked(context)
  }

  /** Whether JS takes wake-ups (src/push.ts, once unlocked); until then the service shows the plain one. */
  @ReactMethod
  fun setListening(on: Boolean) {
    jsListening = on
  }

  // NativeEventEmitter bookkeeping (src/push.ts listens for "PushWake").
  @ReactMethod fun addListener(eventName: String) {}

  @ReactMethod fun removeListeners(count: Int) {}

  override fun invalidate() {
    jsListening = false
    super.invalidate()
  }

  companion object {
    @Volatile var jsListening = false

    // The topics this device is subscribed to, kept here too so they can be
    // renewed without JS (SuperChatMessagingService.onNewToken).
    private const val PREFS = "superchat.push"
    private const val TOPICS = "topics"

    private fun setTopic(context: Context, topic: String, on: Boolean) {
      val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      val topics = prefs.getStringSet(TOPICS, emptySet())!!.toMutableSet()
      if (if (on) topics.add(topic) else topics.remove(topic)) prefs.edit().putStringSet(TOPICS, topics).apply()
    }

    /** Subscribes again to every topic: a new FCM registration starts with none. */
    fun resubscribeAll(context: Context) {
      val topics = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getStringSet(TOPICS, emptySet())!!
      for (t in topics) FirebaseMessaging.getInstance().subscribeToTopic(t)
    }
  }
}

class PushPackage : ReactPackage {
  override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> = listOf(PushModule(context))

  override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
