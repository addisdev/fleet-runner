# Source this (never run it): exports the demo household's standing invite for HomeLake's explore flow.
#
# examples/flows/homelake-android/join-demo.yaml opens MAESTRO_HOMELAKE_DEMO_LINK, the invite's deep link, which
# Maestro hands to the flow from the shell. The invite lives in ~/.config/homelake-demo/invite.json on ultra
# (0600; also the GitHub secret HOMELAKE_DEMO_INVITE; runbook: addisdev/homelake docs/runbooks/demo-hub.md). It is
# read here, at run time, and never written to a manifest, a spec, a card or a log; this file prints nothing.
# Without the file the variable stays unset and explore leaves out the cards that need it (and says so).
_inv="${HOMELAKE_DEMO_INVITE_FILE:-$HOME/.config/homelake-demo/invite.json}"
if [ -r "$_inv" ]; then
  _link="$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("deep_link",""))' "$_inv" 2>/dev/null)"
  [ -z "$_link" ] || export MAESTRO_HOMELAKE_DEMO_LINK="$_link"
  unset _link
fi
unset _inv
