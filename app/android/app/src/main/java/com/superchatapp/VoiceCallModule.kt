package com.superchatapp

import android.util.Log
import android.view.WindowManager
import androidx.core.content.ContextCompat
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.uimanager.ViewManager

/**
 * JS's handle on VoiceCallService (src/call/androidCall.ts). Events come back
 * as "VoiceCall" device events: {type, value}, where type is
 * action (mute/deafen/leave), route (speaker/earpiece/headset), muted
 * (true/false, the system's mute), telecom (ready/unavailable) or failed.
 */
class VoiceCallModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "VoiceCall"

  init {
    VoiceCallService.listener = { type, value ->
      if (reactContext.hasActiveReactInstance()) {
        val map = Arguments.createMap()
        map.putString("type", type)
        map.putString("value", value)
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit("VoiceCall", map)
      }
    }
  }

  override fun invalidate() {
    VoiceCallService.listener = null
    keepTimers(false)
    super.invalidate()
  }

  // Between start and stop. (Not VoiceCallService.running: that turns true only
  // once the service is up, and updates sent before then must still go.)
  private var started = false

  private fun send(action: String, fill: (android.content.Intent) -> Unit = {}) {
    val i = VoiceCallService.intent(reactContext, action)
    fill(i)
    if (action == VoiceCallService.ACTION_START) {
      ContextCompat.startForegroundService(reactContext, i)
      started = true
      return
    }
    if (!started) return
    if (action == VoiceCallService.ACTION_STOP) started = false
    try {
      reactContext.startService(i)
    } catch (e: Exception) {
      // The service is gone and Android won't start one from the background.
      started = false
    }
  }

  /** Starts the call (always from the foreground: joining is). */
  @ReactMethod
  fun start(title: String, status: String, promise: Promise) {
    try {
      send(VoiceCallService.ACTION_START) {
        it.putExtra(VoiceCallService.EXTRA_TITLE, title)
        it.putExtra(VoiceCallService.EXTRA_STATUS, status)
      }
      keepScreenOn(true)
      keepTimers(true)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("E_VOICE_CALL", e)
    }
  }

  @ReactMethod
  fun update(title: String, status: String, muted: Boolean, deafened: Boolean, live: Boolean) {
    send(VoiceCallService.ACTION_UPDATE) {
      it.putExtra(VoiceCallService.EXTRA_TITLE, title)
      it.putExtra(VoiceCallService.EXTRA_STATUS, status)
      it.putExtra(VoiceCallService.EXTRA_MUTED, muted)
      it.putExtra(VoiceCallService.EXTRA_DEAFENED, deafened)
      it.putExtra(VoiceCallService.EXTRA_LIVE, live)
    }
  }

  @ReactMethod
  fun setSpeaker(on: Boolean) {
    send(VoiceCallService.ACTION_SPEAKER) { it.putExtra(VoiceCallService.EXTRA_ON, on) }
  }

  @ReactMethod
  fun stop() {
    keepScreenOn(false)
    keepTimers(false)
    send(VoiceCallService.ACTION_STOP)
  }

  // Required by NativeEventEmitter.
  @ReactMethod fun addListener(@Suppress("UNUSED_PARAMETER") event: String) {}

  @ReactMethod fun removeListeners(@Suppress("UNUSED_PARAMETER") count: Double) {}

  // The keep-alive task's id while in a call (touched on the UI thread only).
  private var keepAliveTask: Int? = null

  /**
   * React Native stops JS timers once the app is in the background (or the
   * screen is locked) unless a headless JS task is running. The voice engine
   * runs on timers (heartbeats, ICE restarts, reconnects): without them the
   * others stop hearing from this device and drop it after PRESENCE_MS. So a
   * call holds a do-nothing task ("VoiceKeepAlive", registered in index.js)
   * open from start to stop.
   */
  private fun keepTimers(on: Boolean) {
    UiThreadUtil.runOnUiThread {
      val tasks = HeadlessJsTaskContext.getInstance(reactContext)
      if (on) {
        if (keepAliveTask != null) return@runOnUiThread
        try {
          keepAliveTask =
              tasks.startTask(
                  HeadlessJsTaskConfig(
                      KEEP_ALIVE_TASK,
                      Arguments.createMap(),
                      0, // no timeout: it lasts as long as the call
                      true)) // allowed while the app is open (it is, at join)
        } catch (e: Exception) {
          Log.w("SuperChatVoice", "keep-alive task failed; timers pause in the background", e)
        }
      } else {
        keepAliveTask?.let { tasks.finishTask(it) }
        keepAliveTask = null
      }
    }
  }

  private fun keepScreenOn(on: Boolean) {
    UiThreadUtil.runOnUiThread {
      val w = reactContext.currentActivity?.window ?: return@runOnUiThread
      if (on) w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      else w.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }
  }
}

private const val KEEP_ALIVE_TASK = "VoiceKeepAlive"

class VoiceCallPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
      listOf(VoiceCallModule(reactContext))

  override fun createViewManagers(
      reactContext: ReactApplicationContext
  ): List<ViewManager<*, *>> = emptyList()
}
