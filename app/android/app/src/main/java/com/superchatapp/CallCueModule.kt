package com.superchatapp

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Handler
import android.os.Looper
import android.util.Base64
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.uimanager.ViewManager
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Plays the voice call's join/leave sounds (src/call/cues.ts), given as a
 * small 16-bit mono WAV. Voice-communication usage, so it mixes into the call
 * on whatever route the call is using, at call volume, without taking audio
 * focus from it.
 */
class CallCueModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "CallCue"

  private val main = Handler(Looper.getMainLooper())

  @ReactMethod
  fun play(wavBase64: String) {
    try {
      val wav = Base64.decode(wavBase64, Base64.DEFAULT)
      if (wav.size <= 44) return
      val rate = ByteBuffer.wrap(wav, 24, 4).order(ByteOrder.LITTLE_ENDIAN).int
      val pcm = wav.copyOfRange(44, wav.size)
      val track =
          AudioTrack.Builder()
              .setAudioAttributes(
                  AudioAttributes.Builder()
                      .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                      .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                      .build())
              .setAudioFormat(
                  AudioFormat.Builder()
                      .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                      .setSampleRate(rate)
                      .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                      .build())
              .setTransferMode(AudioTrack.MODE_STATIC)
              .setBufferSizeInBytes(pcm.size)
              .build()
      track.write(pcm, 0, pcm.size)
      track.play()
      val ms = pcm.size / 2 * 1000L / rate
      main.postDelayed({ runCatching { track.release() } }, ms + 300)
    } catch (_: Exception) {
      // A missing sound never matters to the call itself.
    }
  }
}

class CallCuePackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
      listOf(CallCueModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
      emptyList()
}
