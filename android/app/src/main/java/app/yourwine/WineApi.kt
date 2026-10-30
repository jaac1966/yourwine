package app.yourwine

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

object WineApi {
    private const val BASE = "https://yourwine-api.jaac.workers.dev"
    private val client = OkHttpClient.Builder()
        .callTimeout(40, TimeUnit.SECONDS)
        .connectTimeout(40, TimeUnit.SECONDS)
        .readTimeout(40, TimeUnit.SECONDS)
        .build()
    private val jsonMedia = "application/json".toMediaType()

    suspend fun post(path: String, body: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        val req = Request.Builder().url(BASE + path).post(body.toString().toRequestBody(jsonMedia)).build()
        execute(req)
    }

    suspend fun postAudio(path: String, wav: ByteArray): JSONObject = withContext(Dispatchers.IO) {
        val form = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("audio", "audio.wav", wav.toRequestBody("audio/wav".toMediaType()))
            .build()
        execute(Request.Builder().url(BASE + path).post(form).build())
    }

    private fun execute(req: Request): JSONObject {
        client.newCall(req).execute().use { res ->
            if (!res.isSuccessful) {
                val raw = try { res.body!!.string() } catch (_: Exception) { "" }
                val msg = try { JSONObject(raw).optString("error").ifEmpty { null } } catch (_: Exception) { null }
                throw IOException(msg ?: "HTTP ${res.code}")
            }
            return JSONObject(res.body!!.string())
        }
    }
}
