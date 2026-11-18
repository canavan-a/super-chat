package com.superchatapp

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.uimanager.ViewManager

/**
 * The native launch splash (the launcher icon on a plain background, from
 * Theme.App.Starting) stays up until JS says it has drawn something to take
 * over from: the JS splash, or the app itself when that's turned off. Without
 * this the window sat blank while the app started and loaded its JS, which
 * after an update (no compiled code yet) can take seconds.
 */
object LaunchSplash {
  /** Never keep it up longer than this, whatever JS is doing. */
  const val MAX_MS = 5_000L

  @Volatile var jsReady = false
}

class LaunchSplashModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  override fun getName(): String = "LaunchSplash"

  @ReactMethod
  fun hide() {
    LaunchSplash.jsReady = true
  }
}

class LaunchSplashPackage : ReactPackage {
  override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> =
      listOf(LaunchSplashModule(context))

  override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
