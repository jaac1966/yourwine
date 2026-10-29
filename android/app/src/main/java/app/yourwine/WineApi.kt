package app.yourwine

import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

object WineApi {
    private const val BASE = "https://yourwine-api.jaac.workers.dev"
    private val client = OkHttpClient()
    private val jsonMedia = "application/json".toMediaType()

    suspend fun post(path: String, body: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        val req = Request.Builder().url(BASE + path).post(body.toString().toRequestBody(jsonMedia)).build()
        client.newCall(req).execute().use { res ->
            if (!res.isSuccessful) throw IOException("HTTP ${res.code}")
            JSONObject(res.body!!.string())
        }
    }
}
