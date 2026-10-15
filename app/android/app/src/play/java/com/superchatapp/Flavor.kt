package com.superchatapp

import android.app.Activity
import com.facebook.react.ReactPackage

/**
 * The Google Play build: Play installs updates itself (an app may not), so
 * there's no in-app updater here. Notifications come through FCM instead
 * (PushModule.kt, SuperChatMessagingService.kt). See the sideload flavor's
 * Flavor.kt.
 */
object Flavor {
  fun packages(): List<ReactPackage> = listOf(PushPackage())

  fun onResume(activity: Activity) {}

  fun onPause() {}
}
