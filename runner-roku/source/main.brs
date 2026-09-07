' ============================================================================
' Entry point.
'
' Roku runs `Main` (or `RunUserInterface`) from pkg:/source/ and nothing else;
' a SceneGraph channel's whole job here is to make a screen, hand it the launch
' arguments, and then sit in a message loop until the screen closes. All of the
' actual work happens on the Task thread that FleetScene starts, because a
' BrightScript render thread that is busy hashing is a channel Roku's watchdog
' eventually kills.
'
' == Launch parameters, which is the entire enrolment story ==
'
' `args` is whatever ECP passed on the launch URL:
'
'   curl -d '' "http://<roku>:8060/launch/dev?fleet_url=http%3A%2F%2Ffleet-host.local%3A8788&device_id=roku-den"
'
' That matters more here than on any other platform in this fleet. Every other
' runner has a keyboard, a shell, or an environment variable behind it. A Roku
' has a five-way pad and an on-screen keyboard, and typing
' "http://fleet-host.local:8788" on one is roughly forty button presses with no
' way to paste. So the collector URL arrives over the network, is written to the
' registry, and never has to be typed again -- and the on-screen field exists
' only as the fallback for someone with no host on the LAN to curl from.
'
' The copy below lower-cases the keys and drops any non-string value. Note that
' BrightScript's associative arrays are already case-insensitive on lookup, so
' the lower-casing is belt and braces rather than the fix for a known bug -- the
' load-bearing half is dropping non-strings, because ECP also passes
' `instant_on_run_mode` and a `contentID` through, and the agent should be
' handed a flat map of the parameters it understands rather than the whole
' launch context.
' ============================================================================

sub Main(args as Dynamic)
    screen = CreateObject("roSGScreen")
    port = CreateObject("roMessagePort")
    screen.SetMessagePort(port)

    scene = screen.CreateScene("FleetScene")

    ' Set before Show(): FleetScene observes this field and starts the agent
    ' when it arrives, so handing it over first means a channel launched with a
    ' fleet_url is registering before the splash has finished.
    scene.launchArgs = normaliseArgs(args)

    screen.Show()

    while true
        msg = wait(0, port)
        if type(msg) = "roSGScreenEvent"
            ' The user pressed Home or Back out of the scene. Roku is about to
            ' suspend or tear down this channel either way; returning here is
            ' the only clean exit a SceneGraph channel has.
            if msg.isScreenClosed() then return
        end if
    end while
end sub

' Lower-case every key so a launch parameter is found however it was spelled.
'
' Values are left exactly as they arrived. ECP has already URL-decoded them, so
' a fleet_url of "http%3A%2F%2Fhost%3A8788" reaches us as "http://host:8788"
' and decoding again would corrupt any value that legitimately contains a
' percent sign.
function normaliseArgs(args as Dynamic) as Object
    out = {}
    if type(args) <> "roAssociativeArray" then return out
    for each key in args
        value = args[key]
        if type(value) = "roString" or type(value) = "String"
            out[LCase(key)] = value
        end if
    end for
    return out
end function
