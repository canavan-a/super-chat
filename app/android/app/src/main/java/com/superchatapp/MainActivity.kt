package com.superchatapp

import android.os.Bundle
import android.view.WindowManager
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  override fun onCreate(savedInstanceState: Bundle?) {
    // Always on, set before anything is drawn: blocks screenshots and screen
    // recording, and blanks the app's thumbnail in the recent-apps switcher.
    window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
    super.onCreate(savedInstanceState)
  }

  // Lets a finished update download open the installer straight away while
  // the app is on screen, or as soon as it comes back (UpdateInstaller.kt).
  override fun onResume() {
    super.onResume()
    UpdateInstaller.foreground = true
    UpdateInstaller.promptIfPending(this)
  }

  override fun onPause() {
    UpdateInstaller.foreground = false
    super.onPause()
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "SuperchatApp"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
