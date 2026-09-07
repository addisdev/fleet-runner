' ============================================================================
' The scene: everything the render thread does, which is deliberately almost
' nothing.
'
' It owns the labels, the on-screen keyboard, and the registry. It does NOT
' hash, does not make HTTP requests, and does not sleep -- all three of those
' are on the AgentTask thread. This is not tidiness. A SceneGraph render thread
' that blocks is a channel that stops drawing and stops answering the remote,
' and Roku will eventually kill it; the first symptom of getting this wrong is a
' Roku that appears to have crashed halfway through a benchmark.
'
' The registry is read and written here rather than in the task because
' roRegistrySection is cheap and the scene is the thing that knows what the
' user typed. Writes are flushed immediately: an unflushed registry section is
' lost when the channel is suspended, and Roku suspends a channel the moment
' somebody presses Home -- which is precisely when a just-entered URL would be
' lost, and the failure looks like the keyboard not having worked.
' ============================================================================

sub init()
    m.status = m.top.findNode("status")
    m.detail = m.top.findNode("detail")
    m.deviceLine = m.top.findNode("deviceLine")
    m.urlLine = m.top.findNode("urlLine")
    m.digestLine = m.top.findNode("digestLine")
    m.hint = m.top.findNode("hint")

    m.top.setFocus(true)

    m.agent = createObject("roSGNode", "AgentTask")
    m.agent.observeField("status", "onAgentStatus")
    m.agent.observeField("detail", "onAgentStatus")
    m.agent.observeField("deviceId", "onAgentIdentity")
    m.agent.observeField("digest", "onAgentIdentity")
    m.agent.observeField("jobsRun", "onAgentIdentity")

    m.hint.text = "No collector yet. Press OK to type one, or enrol this Roku from a host on the same network:" + chr(10) + "curl -d '' " + chr(34) + "http://<this-roku>:8060/launch/dev?fleet_url=http%3A%2F%2Ffleet-host.local%3A8788" + chr(34)

    ' If a URL was stored on a previous run, start immediately. A Roku that was
    ' enrolled once should rejoin the fleet on every launch with no interaction
    ' -- the whole point of persisting it.
    stored = fleetRegistryRead("fleet_url")
    if stored <> ""
        startAgent(stored, fleetRegistryRead("device_id"))
    end if
end sub

' Launch parameters arrived. They win over the registry and are written to it,
' so `curl .../launch/dev?fleet_url=...` is both "run against this collector
' now" and "run against this collector from now on".
sub onLaunchArgs()
    args = m.top.launchArgs
    if args = invalid then return

    url = ""
    if args.DoesExist("fleet_url") then url = args["fleet_url"]
    deviceId = ""
    if args.DoesExist("device_id") then deviceId = args["device_id"]

    if deviceId <> "" then fleetRegistryWrite("device_id", deviceId)
    if url <> ""
        fleetRegistryWrite("fleet_url", url)
        startAgent(url, deviceId)
    else if deviceId <> "" and m.agent.control = "RUN"
        ' A device_id arriving mid-run cannot be applied to a registered agent
        ' without unregistering the old id, which would leave a ghost on the
        ' shelf. Say so rather than silently ignoring it.
        m.detail.text = "device_id saved; it takes effect on the next launch"
    end if
end sub

sub startAgent(url as String, deviceId as String)
    ' The already-running guard, and it is not defensive padding: BOTH entry
    ' paths fire on an ordinary ECP launch. init() starts the agent from the
    ' stored URL, and then Main() sets launchArgs, which fires onLaunchArgs with
    ' the same URL a moment later. Without this, every launch of an
    ' already-enrolled Roku would set control to RUN twice, and a Task node given
    ' RUN while it is already running starts a second thread against the same
    ' fields -- two poll loops under one device_id, racing for the same job.
    if m.agent.control = "RUN"
        if m.agent.fleetUrl = url then return
        ' A genuinely different collector: stop the old thread before starting a
        ' new one, for the same reason. The old one is blocked in a long poll
        ' against an address nobody wants any more.
        m.agent.control = "STOP"
    end if

    m.hint.text = ""
    m.agent.fleetUrl = url
    if deviceId <> "" then m.agent.deviceId = deviceId
    m.urlLine.text = "collector: " + url
    ' Setting control to RUN is what actually starts the Task's thread.
    m.agent.control = "RUN"
end sub

sub onAgentStatus()
    m.status.text = m.agent.status
    m.detail.text = m.agent.detail
end sub

sub onAgentIdentity()
    if m.agent.deviceId <> ""
        line = "device: " + m.agent.deviceId
        ' The job count is on the same line rather than its own. A ten-foot UI
        ' is read at a glance and every extra line is one more thing to skip
        ' past; "has it done any work?" and "which device is this?" are the two
        ' questions somebody standing in front of a television actually has.
        if m.agent.jobsRun > 0 then line = line + "   jobs run: " + m.agent.jobsRun.ToStr()
        m.deviceLine.text = line
    end if
    if m.agent.digest <> ""
        ' Shown on screen because this is the one fact about the runner that is
        ' checkable without a collector: if these 64 characters are not the
        ' fleet's, every number this device produces is a different measurement.
        m.digestLine.text = "synthetic digest: " + m.agent.digest
    end if
end sub

' ----------------------------------------------------------------------------
' The keyboard fallback.
'
' Genuinely a fallback. Entering a URL with a five-way pad is about forty button
' presses and there is no paste, so ECP is the intended route and this exists
' for a Roku on a network with no host to curl from.
' ----------------------------------------------------------------------------
function onKeyEvent(key as String, press as Boolean) as Boolean
    if not press then return false
    if key = "OK"
        showUrlKeyboard()
        return true
    end if
    return false
end function

sub showUrlKeyboard()
    kbd = createObject("roSGNode", "KeyboardDialog")
    kbd.title = "Collector URL"
    ' Pre-filled with the stored value, or with a scheme and a colon, because
    ' the alternative is typing "http://" on a grid keyboard every single time.
    stored = fleetRegistryRead("fleet_url")
    if stored = "" then stored = "http://"
    kbd.text = stored
    kbd.buttons = ["Use this collector", "Cancel"]
    kbd.observeField("buttonSelected", "onKeyboardButton")
    m.keyboard = kbd
    m.top.dialog = kbd
end sub

sub onKeyboardButton()
    if m.keyboard = invalid then return
    selected = m.keyboard.buttonSelected
    ' Read the text BEFORE closing: closing the dialog releases it, and reading
    ' a field off a released node is how this reliably returns an empty URL.
    text = m.keyboard.text
    m.keyboard.close = true
    if selected = 0 and text <> "" and text <> "http://"
        fleetRegistryWrite("fleet_url", text)
        startAgent(text, fleetRegistryRead("device_id"))
    end if
    m.keyboard = invalid
end sub

' ----------------------------------------------------------------------------
' The registry.
'
' One named section, so uninstalling the channel takes the settings with it.
' Roku's registry is small (32 KB per channel) and this stores two short
' strings, which is well inside it -- worth knowing because a registry write
' that exceeds the quota fails and returns false rather than throwing.
' ----------------------------------------------------------------------------
function fleetRegistrySection() as Object
    return CreateObject("roRegistrySection", "fleet")
end function

function fleetRegistryRead(key as String) as String
    section = fleetRegistrySection()
    if section = invalid then return ""
    if not section.Exists(key) then return ""
    value = section.Read(key)
    if value = invalid then return ""
    return value
end function

sub fleetRegistryWrite(key as String, value as String)
    section = fleetRegistrySection()
    if section = invalid then return
    section.Write(key, value)
    ' Flush now, not at some convenient later point. See the header: Home
    ' suspends the channel, and an unflushed section does not survive that.
    section.Flush()
end sub
