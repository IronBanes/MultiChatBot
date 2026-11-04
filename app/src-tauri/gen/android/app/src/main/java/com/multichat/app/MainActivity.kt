package com.multichat.app

import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    requestLocalNetworkAccess()
  }

  /** Android 17 blocks apps from the local network (a relay hosted on a PC at home,
   *  and on some networks the DNS server too) until the user allows it. The app's
   *  relay connection retries on its own, so it connects once this is granted. */
  private fun requestLocalNetworkAccess() {
    if (Build.VERSION.SDK_INT < 37) return
    val permission = "android.permission.ACCESS_LOCAL_NETWORK"
    if (checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(arrayOf(permission), 1)
    }
  }
}
