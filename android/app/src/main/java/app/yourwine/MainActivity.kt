package app.yourwine

import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.util.Base64
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
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
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

private const val TAG = "YourWine"
private val PHOTO_RESOLUTION = PhotoResolution.LARGE

class MainActivity : ComponentActivity() {
    private var session: DeviceSession? = null
    private var camera: Camera? = null
    private var photoJobs = emptyList<Job>()
    private var pendingCapture = false
    private var mockGlasses: MockGlasses? = null
    private var tts: TextToSpeech? = null
    private var lastWine: JSONObject? = null

    private var registration by mutableStateOf("unknown")
    private var devices by mutableStateOf(0)
    private var sessionState by mutableStateOf("none")
    private var sessionStarted by mutableStateOf(false)
    private var busy by mutableStateOf(false)
    private var wineName by mutableStateOf("")
    private var readBy by mutableStateOf("")
    private var scores by mutableStateOf("")
    private var lastError by mutableStateOf("")
    private var mockReady by mutableStateOf(false)

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
                registration = state.toString()
                if (state == RegistrationState.REGISTERED && session == null) createSession()
            }
        }
        lifecycleScope.launch {
            Wearables.registrationErrorStream.collect { showError("registration: ${it.description}") }
        }
        lifecycleScope.launch {
            Wearables.devices.collect {
                Log.i(TAG, "devices: ${it.size}")
                devices = it.size
            }
        }
        createSession()
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
        teardownCamera()
        lifecycleScope.launch {
            try {
                val b64 = withContext(Dispatchers.IO) { Base64.encodeToString(jpeg, Base64.NO_WRAP) }
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

    private fun speak(text: String) {
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
                    Text("Registration: $registration")
                    Button(onClick = { Wearables.startRegistration(this@MainActivity) }) {
                        Text("Link glasses")
                    }
                    Text("Session: $sessionState (devices: $devices)")
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
