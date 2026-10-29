package app.yourwine

import android.app.Application
import android.util.Log
import com.meta.wearable.dat.core.Wearables

class YourWineApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Wearables.initialize(this).onFailure { error, _ ->
            Log.e("YourWine", "DAT init failed: ${error.description}")
        }
    }
}
