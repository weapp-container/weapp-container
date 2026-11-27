package dev.weapp.vendor

import android.app.Activity
import android.os.Bundle
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import com.sonofmagic.weapp.container.sdk.HostErrorCode
import com.sonofmagic.weapp.container.sdk.HostMethod
import com.sonofmagic.weapp.container.sdk.PackSource
import com.sonofmagic.weapp.container.sdk.WeappContainerSession
import com.sonofmagic.weapp.container.sdk.WeappContainerView
import org.json.JSONObject

class MainActivity : Activity() {
    private lateinit var surface: WeappContainerView
    private lateinit var status: TextView
    private lateinit var restart: Button
    private var session: WeappContainerSession? = null
    @Volatile private var rejectProfile = false

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        status = TextView(this)
        surface = WeappContainerView(this)
        restart = Button(this).apply {
            text = "Reopen"
            setOnClickListener { reopen() }
        }
        val rejection = Button(this).apply {
            text = "Reject profile"
            setOnClickListener {
                rejectProfile = !rejectProfile
                text = if (rejectProfile) "Allow profile" else "Reject profile"
            }
        }
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(LinearLayout(this@MainActivity).apply {
                addView(restart)
                addView(rejection)
            })
            addView(status)
            addView(surface, LinearLayout.LayoutParams(-1, 0, 1f))
        })
        open()
    }

    private fun open() {
        val next = WeappContainerSession(this, "vendor-demo")
        session = next
        next.registerHostMethod("company.getProfile", HostMethod { _, reply ->
            if (rejectProfile) {
                reply.reject(HostErrorCode.PERMISSION_DENIED, "Profile access denied")
            } else {
                reply.resolve(JSONObject().put("displayName", "Android host"))
            }
        })
        surface.bind(next)
        status.text = "Loading"
        next.load(PackSource.Asset("portable-pack")).whenComplete { _, error ->
            runOnUiThread {
                if (session === next) status.text = error?.message ?: "Ready"
            }
        }
    }

    private fun reopen() {
        restart.isEnabled = false
        close().whenComplete { _, error ->
            runOnUiThread {
                if (isDestroyed) return@runOnUiThread
                restart.isEnabled = true
                if (error == null) open() else status.text = error.message
            }
        }
    }

    private fun close(): java.util.concurrent.CompletableFuture<Unit> {
        val closing = session ?: return java.util.concurrent.CompletableFuture.completedFuture(Unit)
        session = null
        return surface.unbindAsync().handle { _, detachError -> detachError }.thenCompose { detachError ->
            closing.closeAsync().thenApply {
                if (detachError != null) throw detachError
            }
        }
    }

    override fun onResume() {
        super.onResume()
        session?.setForeground(true)
    }

    override fun onPause() {
        session?.setForeground(false)
        super.onPause()
    }

    override fun onDestroy() {
        close()
        super.onDestroy()
    }
}
