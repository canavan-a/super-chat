package com.superchatapp

import android.os.Build
import android.util.Base64
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.Executors
import javax.crypto.AEADBadTagException

/**
 * Opens an attachment (or profile picture) for display entirely off the JS
 * thread: the sealed blob from the device cache (src/blobDisk.ts's folder) or
 * else downloaded into it, then decrypted (XChaCha.java) and handed back as a
 * data: URI. In JS the same work (base64, AEAD over megabytes) froze every
 * tap until it finished. Nothing decrypted is written to disk.
 */
class BlobModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "Blob"

  private val workers = Executors.newFixedThreadPool(3)
  private val dir by lazy { File(reactContext.filesDir, "blobs").apply { mkdirs() } }

  /** Two opens of the same blob at once raced on its download: one at a time per blob (striped, so this never grows). */
  private val locks = Array(16) { Any() }

  private fun fileOf(blob: String) = File(dir, blob.replace(Regex("[^A-Za-z0-9_-]"), "_"))

  /**
   * Resolves with "data:<mime>;base64,…". [url] and [headers] are the signed
   * request to download it when it isn't cached; [key] is the file key
   * (standard base64).
   */
  @ReactMethod
  fun open(blob: String, url: String, headers: ReadableMap, key: String, mime: String, promise: Promise) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
      // No ChaCha20-Poly1305 in the platform before Android 9: JS does it.
      promise.reject("E_UNSUPPORTED", "native blob opening needs Android 9")
      return
    }
    workers.execute {
      try {
        val plain = synchronized(locks[(blob.hashCode() and 0x7fffffff) % locks.size]) { openLocked(blob, url, headers, key) }
        promise.resolve("data:$mime;base64," + Base64.encodeToString(plain, Base64.NO_WRAP))
      } catch (e: OutOfMemoryError) {
        promise.reject("E_BLOB", "That file is too large to show.")
      } catch (e: Exception) {
        promise.reject("E_BLOB", e.message ?: "Couldn't open that file.", e)
      }
    }
  }

  private fun openLocked(blob: String, url: String, headers: ReadableMap, key: String): ByteArray {
    val fileKey = Base64.decode(key, Base64.DEFAULT)
    val file = fileOf(blob)
    var fresh = false
    if (!file.exists()) {
      download(url, headers, file)
      fresh = true
    }
    val plain =
        try {
          XChaCha.open(fileKey, file.readBytes(), AD)
        } catch (e: AEADBadTagException) {
          // A damaged cached copy: fetch it again, once.
          if (fresh) throw e
          file.delete()
          download(url, headers, file)
          XChaCha.open(fileKey, file.readBytes(), AD)
        }
    file.setLastModified(System.currentTimeMillis()) // recently used, for trimming
    return plain
  }

  private fun download(url: String, headers: ReadableMap, into: File) {
    val conn = URL(url).openConnection() as HttpURLConnection
    try {
      conn.connectTimeout = 15_000
      conn.readTimeout = 60_000
      val it = headers.keySetIterator()
      while (it.hasNextKey()) {
        val k = it.nextKey()
        conn.setRequestProperty(k, headers.getString(k))
      }
      val status = conn.responseCode
      if (status != 200) throw IllegalStateException(if (status == 404) "That file is gone." else "Download failed ($status).")
      // Its own temporary file, whatever else is downloading.
      val tmp = File("${into.path}.${UUID.randomUUID()}.part")
      try {
        conn.inputStream.use { input -> tmp.outputStream().use { input.copyTo(it) } }
        if (!tmp.renameTo(into)) throw IllegalStateException("Couldn't save the download.")
      } finally {
        tmp.delete()
      }
    } finally {
      conn.disconnect()
    }
  }

  companion object {
    private val AD = "sc-blob".toByteArray()
  }
}
