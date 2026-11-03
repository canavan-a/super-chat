package com.superchatapp

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.telecom.DisconnectCause
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.core.telecom.CallAttributesCompat
import androidx.core.telecom.CallControlScope
import androidx.core.telecom.CallEndpointCompat
import androidx.core.telecom.CallsManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

/**
 * A voice room, as Android sees it: a self-managed call.
 *
 * - Registered with Telecom through Jetpack Core-Telecom, so the system owns
 *   the call audio (communication mode, Bluetooth/wired/earpiece/speaker
 *   routing, audio focus) and the call shows up to headsets, cars and watches.
 *   Nothing else in the app touches audio modes or Bluetooth on Android, so
 *   routes don't flap (which made Bluetooth headsets play their call
 *   start/end tones mid-call).
 * - A phoneCall|microphone foreground service of its own, with a CallStyle
 *   notification (the status-bar call chip), separate from Notifee's
 *   background-messages service.
 *
 * Driven from JS by VoiceCallModule (src/call/androidCall.ts); what happens
 * here (notification buttons, the system ending the call, route changes)
 * goes back the same way.
 */
class VoiceCallService : Service() {

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
  private var control: CallControlScope? = null
  private var endpoints: List<CallEndpointCompat> = emptyList()
  private var current: CallEndpointCompat? = null
  private var pickedDefault = false
  private var ending = false

  private var title = "Super Chat"
  private var status = "Connecting…"
  private var muted = false
  private var deafened = false
  private var liveSince = 0L

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_START -> {
        readState(intent)
        if (!goForeground()) {
          stopSelf()
          return START_NOT_STICKY
        }
        if (control == null) addCall()
      }
      ACTION_UPDATE -> {
        readState(intent)
        if (running) post() else stopSelf()
      }
      ACTION_SPEAKER -> setSpeaker(intent.getBooleanExtra(EXTRA_ON, true))
      ACTION_STOP -> end()
      ACTION_MUTE, ACTION_DEAFEN, ACTION_LEAVE ->
          emit("action", intent.action!!.removePrefix(PREFIX))
      // Restarted by the system after the process died: the call is gone.
      else -> end()
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    running = false
    scope.cancel()
    super.onDestroy()
  }

  // ---- the notification ----

  private fun readState(i: Intent) {
    i.getStringExtra(EXTRA_TITLE)?.let { title = it.ifBlank { "Super Chat" } }
    i.getStringExtra(EXTRA_STATUS)?.let { status = it }
    muted = i.getBooleanExtra(EXTRA_MUTED, muted)
    deafened = i.getBooleanExtra(EXTRA_DEAFENED, deafened)
    val live = i.getBooleanExtra(EXTRA_LIVE, liveSince != 0L)
    liveSince = if (!live) 0L else if (liveSince == 0L) System.currentTimeMillis() else liveSince
  }

  private fun service(action: String, code: Int): PendingIntent =
      PendingIntent.getService(
          this,
          code,
          Intent(this, VoiceCallService::class.java).setAction(action),
          PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

  private fun build(): android.app.Notification {
    val open =
        PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val b =
        NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(status)
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setStyle(
                NotificationCompat.CallStyle.forOngoingCall(
                    Person.Builder().setName(title).setImportant(true).build(),
                    service(ACTION_LEAVE, 3)))
            .addAction(0, if (muted) "Unmute" else "Mute", service(ACTION_MUTE, 1))
            .addAction(0, if (deafened) "Sound on" else "Sound off", service(ACTION_DEAFEN, 2))
    if (liveSince != 0L) b.setWhen(liveSince).setUsesChronometer(true).setShowWhen(true)
    return b.build()
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = getSystemService(NotificationManager::class.java)
    if (nm.getNotificationChannel(CHANNEL) != null) return
    nm.createNotificationChannel(
        NotificationChannel(CHANNEL, "Voice", NotificationManager.IMPORTANCE_LOW).apply {
          description = "While you're in a voice room"
          setShowBadge(false)
        })
  }

  /** startForeground with the call notification; false if Android refused. */
  private fun goForeground(): Boolean {
    ensureChannel()
    // A microphone-type service started without the mic permission kills the
    // app on Android 14+; JS only starts this after the permission is granted.
    val mic =
        ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
    var types = 0
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      types = ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL
    }
    if (mic && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
    }
    return try {
      ServiceCompat.startForeground(this, NOTIFICATION_ID, build(), types)
      running = true
      true
    } catch (e: Exception) {
      Log.w(TAG, "startForeground failed", e)
      emit("failed", e.message ?: "foreground service refused")
      false
    }
  }

  private fun post() {
    if (!running) return
    try {
      NotificationManagerCompat.from(this).notify(NOTIFICATION_ID, build())
    } catch (e: SecurityException) {
      // Notifications turned off: the service's own notification still stands.
    }
  }

  // ---- Telecom ----

  private fun addCall() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      emit("telecom", "unavailable")
      return
    }
    scope.launch {
      try {
        val manager = CallsManager(this@VoiceCallService)
        manager.registerAppWithTelecom(CallsManager.CAPABILITY_BASELINE)
        val attrs =
            CallAttributesCompat(
                title,
                Uri.parse("superchat:voice"),
                CallAttributesCompat.DIRECTION_OUTGOING,
                CallAttributesCompat.CALL_TYPE_AUDIO_CALL,
                CallAttributesCompat.SUPPORTS_SET_INACTIVE,
            )
        manager.addCall(
            attrs,
            onAnswer = {},
            // Ended from outside the app: a car or watch, a headset's hang-up
            // button, or the user ending it for a phone call.
            onDisconnect = {
              control = null
              if (!ending) emit("action", "leave")
            },
            onSetActive = {},
            onSetInactive = {},
        ) {
          control = this
          launch { setActive() }
          launch {
            combine(currentCallEndpoint, availableEndpoints) { cur, all -> cur to all }
                .collect { (cur, all) -> onEndpoints(cur, all) }
          }
          // The system's own mute (a headset or car button, a watch).
          launch { isMuted.distinctUntilChanged().collect { emit("muted", it.toString()) } }
          emit("telecom", "ready")
        }
      } catch (e: Exception) {
        Log.w(TAG, "Telecom call failed; audio falls back to the app", e)
        control = null
        emit("telecom", "unavailable")
      }
    }
  }

  private fun onEndpoints(cur: CallEndpointCompat, all: List<CallEndpointCompat>) {
    current = cur
    endpoints = all
    // A voice room starts on the loudspeaker, not the earpiece (as before).
    // Headsets still win: Telecom starts on one if it's connected, and
    // switches to one that connects mid-call.
    if (!pickedDefault) {
      pickedDefault = true
      if (cur.type == CallEndpointCompat.TYPE_EARPIECE) {
        all.firstOrNull { it.type == CallEndpointCompat.TYPE_SPEAKER }?.let { request(it) }
      }
    }
    emit(
        "route",
        when (cur.type) {
          CallEndpointCompat.TYPE_BLUETOOTH,
          CallEndpointCompat.TYPE_WIRED_HEADSET -> "headset"
          CallEndpointCompat.TYPE_EARPIECE -> "earpiece"
          else -> "speaker"
        })
  }

  private fun request(e: CallEndpointCompat) {
    val c = control ?: return
    c.launch { c.requestEndpointChange(e) }
  }

  /** Speaker on, or off: to a headset if one's connected, else the earpiece. */
  private fun setSpeaker(on: Boolean) {
    val want =
        if (on) listOf(CallEndpointCompat.TYPE_SPEAKER)
        else
            listOf(
                CallEndpointCompat.TYPE_BLUETOOTH,
                CallEndpointCompat.TYPE_WIRED_HEADSET,
                CallEndpointCompat.TYPE_EARPIECE)
    for (t in want) {
      val e = endpoints.firstOrNull { it.type == t } ?: continue
      if (e != current) request(e)
      return
    }
  }

  private fun end() {
    ending = true
    val c = control
    control = null
    if (c != null) {
      // Let the disconnect reach Telecom before the scope goes.
      scope.launch {
        try {
          c.disconnect(DisconnectCause(DisconnectCause.LOCAL))
        } catch (e: Exception) {
          Log.w(TAG, "disconnect failed", e)
        }
        stop()
      }
    } else {
      stop()
    }
  }

  private fun stop() {
    running = false
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  companion object {
    private const val TAG = "SuperChatVoice"
    const val CHANNEL = "superchat-voice"
    const val NOTIFICATION_ID = 0x5c_0001

    private const val PREFIX = "com.superchatapp.voice."
    const val ACTION_START = PREFIX + "start"
    const val ACTION_UPDATE = PREFIX + "update"
    const val ACTION_SPEAKER = PREFIX + "speaker"
    const val ACTION_STOP = PREFIX + "stop"
    const val ACTION_MUTE = PREFIX + "mute"
    const val ACTION_DEAFEN = PREFIX + "deafen"
    const val ACTION_LEAVE = PREFIX + "leave"

    const val EXTRA_TITLE = "title"
    const val EXTRA_STATUS = "status"
    const val EXTRA_MUTED = "muted"
    const val EXTRA_DEAFENED = "deafened"
    const val EXTRA_LIVE = "live"
    const val EXTRA_ON = "on"

    @Volatile var running = false

    /** Set by VoiceCallModule: events for JS (type, value). */
    @Volatile var listener: ((String, String) -> Unit)? = null

    private fun emit(type: String, value: String) {
      listener?.invoke(type, value)
    }

    fun intent(context: Context, action: String): Intent =
        Intent(context, VoiceCallService::class.java).setAction(action)
  }
}
