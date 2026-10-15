package com.superchatapp

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
      if (it.isSuccessful) promise.resolve(null) else promise.reject("push", it.exception?.message ?: "subscribe failed")
    }
  }

  @ReactMethod
  fun unsubscribe(topic: String, promise: Promise) {
    FirebaseMessaging.getInstance().unsubscribeFromTopic(topic).addOnCompleteListener {
      if (it.isSuccessful) promise.resolve(null) else promise.reject("push", it.exception?.message ?: "unsubscribe failed")
    }
  }

  /** Removes the plain "New message" shown while the app was closed. */
  @ReactMethod
  fun clearLocked() {
    val nm = context.getSystemService(android.content.Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
    nm.cancel(SuperChatMessagingService.NID)
  }

  // NativeEventEmitter bookkeeping (src/push.ts listens for "PushWake").
  @ReactMethod fun addListener(eventName: String) {}

  @ReactMethod fun removeListeners(count: Int) {}
}

class PushPackage : ReactPackage {
  override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> = listOf(PushModule(context))

  override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
