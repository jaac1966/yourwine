package app.yourwine

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.ToneGenerator
import android.os.Bundle
import android.os.SystemClock
import android.speech.tts.TextToSpeech
import android.util.Base64
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.lifecycle.lifecycleScope
import com.meta.wearable.dat.camera.Camera
import com.meta.wearable.dat.camera.addCamera
import com.meta.wearable.dat.camera.photo.types.PhotoQuality
import com.meta.wearable.dat.camera.photo.types.PhotoResolution
import com.meta.wearable.dat.camera.photo.types.PhotoState
import com.meta.wearable.dat.camera.removeCamera
import com.meta.wearable.dat.core.Wearables
import com.meta.wearable.dat.core.selectors.AutoDeviceSelector
import com.meta.wearable.dat.core.session.DeviceSession
import com.meta.wearable.dat.core.session.DeviceSessionState
import com.meta.wearable.dat.core.types.Permission
import com.meta.wearable.dat.core.types.PermissionStatus
import com.meta.wearable.dat.core.types.RegistrationState
import com.meta.wearable.dat.mockdevice.MockDeviceKit
import com.meta.wearable.dat.mockdevice.api.GlassesModel
import com.meta.wearable.dat.mockdevice.api.MockGlasses
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import kotlin.math.sqrt

private const val TAG = "YourWine"
private const val MIN_LISTEN_MS = 1500L
private const val MAX_LISTEN_MS = 5000L
private const val SILENCE_MS = 1200L
private const val SPEECH_CONFIRM_MS = 300L

private data class VoiceCapture(val pcm: ByteArray, val sco: AudioDeviceInfo?, val speechMs: Long)
private const val SAMPLE_RATE = 16000
private const val RMS_THRESHOLD = 300.0
private val PHOTO_RESOLUTION = PhotoResolution.LARGE
private val WOULD_NAME = Regex("would\\s+([a-z]+)")
private val AND_FOR_NAME = Regex("and for\\s+([a-z]+)")

class MainActivity : ComponentActivity() {
    private var session: DeviceSession? = null
    private var camera: Camera? = null
    private var photoJobs = emptyList<Job>()
    private var pendingCapture = false
    private var mockGlasses: MockGlasses? = null
    private var tts: TextToSpeech? = null
    private var lastWine: JSONObject? = null
    private var lastScores = mapOf<String, Int>()
    private var lastNames = mapOf<String, String>()

    private var registration: RegistrationState? by mutableStateOf(null)
    private var devices by mutableStateOf(0)
    private var sessionState by mutableStateOf("none")
    private var sessionStarted by mutableStateOf(false)
    private var busy by mutableStateOf(false)
    private var wineName by mutableStateOf("")
    private var readBy by mutableStateOf("")
    private var scores by mutableStateOf("")
    private var lastError by mutableStateOf("")
    private var mockReady by mutableStateOf(false)
    private var lastPhotoPath by mutableStateOf<String?>(null)
    private var showFullPhoto by mutableStateOf(false)
    private var heard by mutableStateOf("")
    private var voiceError by mutableStateOf("")
    private var micStatus by mutableStateOf("")
    private var sessionRetry: Job? = null

    private val permissionLauncher =
        registerForActivityResult(Wearables.RequestPermissionContract()) { result ->
            result.fold(
                onSuccess = { status ->
                    if (status == PermissionStatus.Granted) startCapture()
                    else {
                        showError("camera permission denied")
                        busy = false
                    }
                },
                onFailure = { error, _ ->
                    showError("permission: ${error.description}")
                    busy = false
                },
            )
        }

    private val recordAudioLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) listenAndAct()
            else {
                showError("mic permission denied")
                busy = false
            }
        }

    private val photoPicker =
        registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
            if (uri == null) return@registerForActivityResult
            mockGlasses?.services?.cameraCapture?.setCapturedPhoto(uri)
            Log.i(TAG, "mock photo set: $uri")
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        tts = TextToSpeech(this) { status ->
            if (status == TextToSpeech.SUCCESS) tts?.language = Locale.US
        }
        lifecycleScope.launch {
            Wearables.registrationState.collect { state ->
                Log.i(TAG, "registration: $state")
                registration = state
            }
        }
        lifecycleScope.launch {
            Wearables.registrationErrorStream.collect { showError("registration: ${it.description}") }
        }
        lifecycleScope.launch {
            Wearables.devices.collect {
                Log.i(TAG, "devices: ${it.size}")
                devices = it.size
                if (it.isEmpty()) {
                    sessionRetry?.cancel()
                    sessionRetry = null
                } else if (session == null) {
                    startSessionRetry()
                }
            }
        }
        lastPhotoPath = File(filesDir, "last.jpg").takeIf { it.exists() }?.absolutePath
        setContent { Screen() }
    }

    override fun onDestroy() {
        teardownCamera()
        session?.stop()
        session = null
        tts?.shutdown()
        tts = null
        super.onDestroy()
    }

    private fun startSessionRetry() {
        if (sessionRetry != null) return
        sessionRetry = lifecycleScope.launch {
            var attempt = 0
            val deadline = System.currentTimeMillis() + 60_000
            while (session == null && devices > 0 && System.currentTimeMillis() < deadline) {
                attempt += 1
                Log.i(TAG, "session attempt $attempt")
                createSession()
                if (session == null) delay(2000)
            }
            sessionRetry = null
        }
    }

    private fun createSession() {
        session?.stop()
        session = null
        camera = null
        sessionStarted = false
        Wearables.createSession(AutoDeviceSelector()).fold(
            onSuccess = { created ->
                session = created
                lifecycleScope.launch {
                    created.errors.collect { showError("session: ${it.description}") }
                }
                lifecycleScope.launch {
                    created.state.collect { state ->
                        Log.i(TAG, "session: $state")
                        sessionState = state.toString()
                        sessionStarted = state == DeviceSessionState.STARTED
                        if (state == DeviceSessionState.STARTED) lastError = ""
                        if (state == DeviceSessionState.STOPPED && session === created) {
                            session = null
                            camera = null
                        }
                    }
                }
                created.start()
            },
            onFailure = { error, _ -> showError("createSession: ${error.description}") },
        )
    }

    private fun onAsk() {
        if (busy) return
        busy = true
        lastError = ""
        heard = ""
        voiceError = ""
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            recordAudioLauncher.launch(Manifest.permission.RECORD_AUDIO)
            return
        }
        listenAndAct()
    }

    private fun listenAndAct() {
        lifecycleScope.launch {
            val text = try {
                val recStart = SystemClock.elapsedRealtime()
                val (pcm, sco, speechMs) = withContext(Dispatchers.IO) { recordVoice() }
                val recMs = SystemClock.elapsedRealtime() - recStart
                micStatus = if (sco == null) "Mic: phone, $speechMs ms speech"
                else "Mic: ${sco.type}/${sco.productName}, ${pcm.size} bytes, $recMs ms, $speechMs ms speech"
                val wav = withContext(Dispatchers.IO) { pcmToWav(pcm) }
                try {
                    WineApi.postAudio("/transcribe", wav).optString("text", "")
                } catch (e: Exception) {
                    Log.w(TAG, "transcribe failed: ${e.message}")
                    voiceError = "Voice: transcribe failed — ${e.message}"
                    ""
                }
            } catch (e: Exception) {
                Log.w(TAG, "record failed: ${e.message}")
                ""
            }
            heard = text
            handleVoice(text)
        }
    }

    private fun recordVoice(): VoiceCapture {
        try {
            val tone = ToneGenerator(AudioManager.STREAM_MUSIC, 80)
            try {
                tone.startTone(ToneGenerator.TONE_PROP_BEEP, 150)
                SystemClock.sleep(200)
            } finally {
                tone.release()
            }
        } catch (_: Exception) {
        }
        val audioManager = getSystemService(AUDIO_SERVICE) as AudioManager
        val sco = audioManager.availableCommunicationDevices
            .firstOrNull { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
        if (sco != null) {
            try {
                audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
            } catch (_: Exception) {
            }
            try {
                audioManager.setCommunicationDevice(sco)
            } catch (_: Exception) {
            }
        }
        try {
            val minBuf = AudioRecord.getMinBufferSize(
                SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
            )
            val record = AudioRecord(
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
                maxOf(minBuf, SAMPLE_RATE * 2),
            )
            try {
                record.startRecording()
                val pcm = ByteArrayOutputStream()
                val chunk = ShortArray(1600)
                val start = SystemClock.elapsedRealtime()
                var lastVoice = start
                var aboveSince: Long? = null
                var speechDetected = false
                var speechMs = 0L
                while (true) {
                    val now = SystemClock.elapsedRealtime()
                    if (now - start >= MAX_LISTEN_MS) break
                    val n = record.read(chunk, 0, chunk.size)
                    if (n <= 0) continue
                    var sum = 0.0
                    for (i in 0 until n) sum += chunk[i].toDouble() * chunk[i]
                    if (sqrt(sum / n) >= RMS_THRESHOLD) {
                        lastVoice = now
                        speechMs += n * 1000L / SAMPLE_RATE
                        val since = aboveSince
                        if (since == null) {
                            aboveSince = now
                        } else if (now - since >= SPEECH_CONFIRM_MS) {
                            speechDetected = true
                        }
                    } else {
                        aboveSince = null
                    }
                    val bytes = ByteBuffer.allocate(n * 2).order(ByteOrder.LITTLE_ENDIAN)
                    for (i in 0 until n) bytes.putShort(chunk[i])
                    pcm.write(bytes.array(), 0, n * 2)
                    if (speechDetected && now - start >= MIN_LISTEN_MS && now - lastVoice >= SILENCE_MS) break
                }
                try {
                    record.stop()
                } catch (_: Exception) {
                }
                return VoiceCapture(pcm.toByteArray(), sco, speechMs)
            } finally {
                record.release()
            }
        } finally {
            try {
                audioManager.clearCommunicationDevice()
            } catch (_: Exception) {
            }
            try {
                audioManager.mode = AudioManager.MODE_NORMAL
            } catch (_: Exception) {
            }
        }
    }

    private fun pcmToWav(pcm: ByteArray): ByteArray {
        val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
        header.put("RIFF".toByteArray(Charsets.US_ASCII))
        header.putInt(36 + pcm.size)
        header.put("WAVE".toByteArray(Charsets.US_ASCII))
        header.put("fmt ".toByteArray(Charsets.US_ASCII))
        header.putInt(16)
        header.putShort(1)
        header.putShort(1)
        header.putInt(SAMPLE_RATE)
        header.putInt(SAMPLE_RATE * 2)
        header.putShort(2)
        header.putShort(16)
        header.put("data".toByteArray(Charsets.US_ASCII))
        header.putInt(pcm.size)
        return header.array() + pcm
    }

    private fun handleVoice(text: String) {
        val lower = text.lowercase()
        if (lower.contains("not for me")) {
            sendFeedbackVoiced(false)
            return
        }
        if (lower.contains("loved")) {
            sendFeedbackVoiced(true)
            return
        }
        if (lower.contains("and for") || WOULD_NAME.containsMatchIn(lower)) {
            val hit = findBuddyScore(lower)
            if (hit != null) {
                speak("${hit.first}: ${hit.second} percent")
                busy = false
                return
            }
        }
        // Scan intents ("like", "this one", empty/failed transcription) and any
        // unrecognized text fall through here: no speech = scan, never get stuck.
        @Suppress("UNUSED_VARIABLE")
        val scanIntent = lower.contains("like") || lower.contains("this one") || lower.isEmpty()
        lifecycleScope.launch {
            val granted = Wearables.checkPermissionStatus(Permission.CAMERA).fold(
                onSuccess = { it == PermissionStatus.Granted },
                onFailure = { error, _ ->
                    showError("permission: ${error.description}")
                    false
                },
            )
            if (granted) startCapture() else permissionLauncher.launch(Permission.CAMERA)
        }
    }

    private fun findBuddyScore(lower: String): Pair<String, Int>? {
        for ((key, score) in lastScores) {
            if (lower.contains(key)) {
                val display = lastNames[key] ?: key.replaceFirstChar(Char::uppercase)
                return display to score
            }
        }
        val candidates = listOfNotNull(
            WOULD_NAME.find(lower)?.groupValues?.getOrNull(1),
            AND_FOR_NAME.find(lower)?.groupValues?.getOrNull(1),
        )
        for (name in candidates) {
            val score = lastScores[name]
            if (score != null) {
                val display = lastNames[name] ?: name.replaceFirstChar(Char::uppercase)
                return display to score
            }
        }
        return null
    }

    private fun sendFeedbackVoiced(loved: Boolean) {
        val wine = lastWine
        if (wine == null) {
            handleVoice("")
            return
        }
        lifecycleScope.launch {
            try {
                WineApi.post(
                    "/feedback", JSONObject()
                        .put("user", "alex")
                        .put("wine", wine)
                        .put("verdict", if (loved) "loved" else "not_for_me"),
                )
            } catch (e: Exception) {
                showError("api: ${e.message}")
            }
            speak("Got it")
            busy = false
        }
    }

    private fun startCapture() {
        val active = session
        if (active == null || !sessionStarted) {
            showError("no started session")
            busy = false
            return
        }
        teardownCamera()
        active.addCamera().fold(
            onSuccess = { added ->
                camera = added
                subscribePhoto(added)
            },
            onFailure = { error, _ ->
                showError("addCamera: ${error.description}")
                busy = false
            },
        )
    }

    private fun subscribePhoto(added: Camera) {
        val photo = added.photo
        pendingCapture = true
        photoJobs = listOf(
            lifecycleScope.launch {
                photo.state.collect { state ->
                    Log.i(TAG, "photo: $state")
                    if (state == PhotoState.STARTED && pendingCapture) {
                        pendingCapture = false
                        photo.capturePhoto(resolution = PHOTO_RESOLUTION, quality = PhotoQuality.MEDIUM)
                    }
                }
            },
            lifecycleScope.launch {
                photo.photoStream.collect { capture -> onPhoto(capture.imageData) }
            },
            lifecycleScope.launch {
                photo.transferProgressStream.collect { progress ->
                    Log.i(TAG, "photo progress: ${progress.bytesReceived}/${progress.totalBytes}")
                }
            },
            lifecycleScope.launch {
                photo.errors.collect {
                    showError("photo: ${it.description}")
                    busy = false
                }
            },
        )
    }

    private fun teardownCamera() {
        photoJobs.forEach { it.cancel() }
        photoJobs = emptyList()
        pendingCapture = false
        camera?.stop()
        camera = null
        session?.removeCamera()?.onFailure { error, _ -> Log.w(TAG, "removeCamera: ${error.description}") }
    }

    private fun onPhoto(jpeg: ByteArray) {
        busy = true
        teardownCamera()
        lifecycleScope.launch {
            try {
                val normalized = withContext(Dispatchers.IO) { normalizePhoto(jpeg) }
                lastPhotoPath = withContext(Dispatchers.IO) {
                    File(filesDir, "last.jpg").apply { writeBytes(normalized) }.absolutePath
                }
                val b64 = withContext(Dispatchers.IO) { Base64.encodeToString(normalized, Base64.NO_WRAP) }
                val scan = WineApi.post(
                    "/scan", JSONObject()
                        .put("photo_b64", b64)
                        .put("mime", "image/jpeg")
                        .put("user", "alex")
                        .put("buddies", "ana,luis"),
                )
                val wine = scan.getJSONObject("wine")
                lastWine = wine
                val matches = scan.getJSONArray("matches")
                lastScores = (0 until matches.length()).associate {
                    val m = matches.getJSONObject(it)
                    m.getString("user").lowercase() to m.getInt("score")
                }
                lastNames = (0 until matches.length()).associate {
                    val m = matches.getJSONObject(it)
                    val id = m.getString("user")
                    id.lowercase() to id.replaceFirstChar(Char::uppercase)
                }
                val me = matches.getJSONObject(0).getInt("score")
                wineName = wine.getString("name")
                readBy = scan.getString("readBy")
                scores = (0 until matches.length()).joinToString(" · ") {
                    val m = matches.getJSONObject(it)
                    "${m.getString("user")}: ${m.getInt("score")}%"
                }
                speak(
                    "$me% for you. " + (1 until matches.length()).joinToString(", ") {
                        val m = matches.getJSONObject(it)
                        "${m.getInt("score")}% for ${m.getString("user").replaceFirstChar(Char::uppercase)}"
                    } + ".",
                )
                val explain = WineApi.post(
                    "/explain", JSONObject()
                        .put("wine", wine)
                        .put(
                            "profile", JSONObject()
                                .put("acidity", 2).put("sweetness", 4).put("tannin", 2).put("body", 3),
                        )
                        .put("score", me)
                        .put("lastLoved", JSONObject().put("grape", "Zinfandel").put("country", "USA")),
                )
                speak(explain.getString("text"))
            } catch (e: Exception) {
                showError("api: ${e.message}")
            } finally {
                busy = false
            }
        }
    }

    private fun onFeedback(loved: Boolean) {
        val wine = lastWine ?: return
        lifecycleScope.launch {
            try {
                WineApi.post(
                    "/feedback", JSONObject()
                        .put("user", "alex")
                        .put("wine", wine)
                        .put("verdict", if (loved) "loved" else "not_for_me"),
                )
                Log.i(TAG, "feedback sent: $loved")
            } catch (e: Exception) {
                showError("api: ${e.message}")
            }
        }
    }

    private fun useMock() {
        val kit = MockDeviceKit.getInstance(this)
        if (!kit.isEnabled) kit.enable()
        kit.pairGlasses(GlassesModel.RAYBAN_META).fold(
            onSuccess = { glasses ->
                mockGlasses = glasses
                glasses.powerOn()
                glasses.unfold()
                glasses.don()
                mockReady = true
                createSession()
                Log.i(TAG, "mock glasses paired")
            },
            onFailure = { error, _ -> showError("mock: ${error.description}") },
        )
    }

    private fun normalizePhoto(jpeg: ByteArray): ByteArray {
        val format = when {
            jpeg.size >= 2 && jpeg[0] == 0xFF.toByte() && jpeg[1] == 0xD8.toByte() -> "JPEG"
            jpeg.size >= 8 && String(jpeg, 4, 4, Charsets.US_ASCII) == "ftyp" -> "HEIC/HEIF"
            else -> "unknown"
        }
        Log.i(TAG, "capture format: $format, ${jpeg.size} bytes")
        val bitmap = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)
        if (bitmap == null) {
            Log.w(TAG, "could not decode capture, sending as-is")
            return jpeg
        }
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, 85, out)
        bitmap.recycle()
        val recoded = out.toByteArray()
        Log.i(TAG, "re-encoded JPEG q85: ${recoded.size} bytes")
        return recoded
    }

    private fun decodeThumbnail(path: String, maxDim: Int): ImageBitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(path, bounds)
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxDim) sample *= 2
        return BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = sample })?.asImageBitmap()
    }

    private fun speak(text: String) {
        // recordVoice() always calls clearCommunicationDevice() before returning,
        // so every speak() below runs on the normal output route, never SCO.
        Log.i(TAG, "say: $text")
        tts?.speak(text, TextToSpeech.QUEUE_ADD, null as Bundle?, null as String?)
    }

    private fun showError(msg: String) {
        Log.e(TAG, msg)
        lastError = msg
    }

    @Composable
    private fun Screen() {
        MaterialTheme {
            Surface(modifier = Modifier.fillMaxSize()) {
                Column(
                    modifier = Modifier.fillMaxSize().padding(24.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text("Registration: ${registration ?: "unknown"}")
                    Button(
                        onClick = { Wearables.startRegistration(this@MainActivity) },
                        enabled = registration != RegistrationState.REGISTERED,
                    ) {
                        Text(if (registration == RegistrationState.REGISTERED) "Linked" else "Link glasses")
                    }
                    Text("Session: $sessionState (devices: $devices)")
                    Button(onClick = { if (devices > 0) createSession() }, enabled = devices > 0) {
                        Text("Start session")
                    }
                    if (BuildConfig.DEBUG) {
                        Button(onClick = { useMock() }) { Text("Use mock glasses") }
                        if (mockReady) {
                            Button(onClick = { photoPicker.launch("image/*") }) { Text("Pick label photo") }
                        }
                    }
                    Button(
                        onClick = { onAsk() },
                        enabled = sessionStarted && !busy,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(if (busy) "Asking…" else "Ask", style = MaterialTheme.typography.headlineMedium)
                    }
                    if (heard.isNotEmpty()) Text("Heard: $heard")
                    if (voiceError.isNotEmpty()) Text(voiceError)
                    if (micStatus.isNotEmpty()) Text(micStatus)
                    lastPhotoPath?.let { path ->
                        val thumb = remember(path) { decodeThumbnail(path, 512) }
                        if (thumb != null) {
                            Image(
                                bitmap = thumb,
                                contentDescription = "last label photo",
                                contentScale = ContentScale.Crop,
                                modifier = Modifier.size(96.dp).clickable { showFullPhoto = true },
                            )
                        }
                    }
                    val fullPath = lastPhotoPath
                    if (showFullPhoto && fullPath != null) {
                        val full = remember(fullPath) { decodeThumbnail(fullPath, 2048) }
                        Dialog(onDismissRequest = { showFullPhoto = false }) {
                            if (full != null) {
                                Image(bitmap = full, contentDescription = null, contentScale = ContentScale.Fit)
                            }
                        }
                    }
                    if (wineName.isNotEmpty()) {
                        Text(wineName, style = MaterialTheme.typography.titleLarge)
                        Text("read by $readBy")
                        Text(scores)
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Button(onClick = { onFeedback(true) }, enabled = lastWine != null) { Text("Loved it") }
                        Button(onClick = { onFeedback(false) }, enabled = lastWine != null) { Text("Not for me") }
                    }
                    if (lastError.isNotEmpty()) Text("Error: $lastError")
                }
            }
        }
    }
}
