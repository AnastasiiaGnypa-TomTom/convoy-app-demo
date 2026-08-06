# Convoy App — demo speech

Simple wording. `[DO]` = what you click. Everything else is what you say.

Total: about 8 minutes. You can cut sections 7 and 9 if you only have 5 minutes.

---

## 1. Opening (30 sec)

> Hello everyone. Thank you for your time.
>
> Today I want to show you something we built together — TomTom and Vantor.
>
> It is one map. Vantor gives us the satellite picture of the ground. TomTom gives us
> the roads, the traffic, and the routing. Two very different kinds of data, working
> in one screen.
>
> I will show you a real problem, and how this solves it.

---

## 2. The problem (30 sec)

> Imagine you must move a heavy convoy. Sixty tonnes. Almost five metres high.
>
> A normal map app will send you the fastest way. But the fastest way may have a
> bridge that is too weak. Or a tunnel that is too low. If you find that out when you
> are already there, you have a serious problem.
>
> So the question is not "what is the fastest route". The question is "what is a route
> my vehicle can actually take".

---

## 3. The map (1 min)

`[DO]` Show the app. `[DO]` Click **Satellite**.

> This is the map. Now I switch to satellite.
>
> This picture comes from Vantor. It is real imagery of the ground — you can see the
> buildings, the fields, the parking areas.
>
> And look — the roads and the road names are still on top. That is TomTom. So you get
> the truth of the picture, plus the intelligence of the road network.
>
> This matters, because a map drawing tells you where the road is. The imagery tells
> you what is actually there right now.

`[DO]` Zoom in on something with detail — a port, an airfield, an industrial area.

---

## 4. Plan a convoy route (1.5 min)

`[DO]` Type a start and a destination. `[DO]` Open the vehicle list.

> Now I plan a route. First, I choose my vehicle.
>
> This is important. I am not choosing "car" or "truck". I choose what I really have.

`[DO]` Select **Oversized / heavy convoy**.

> Sixty tonnes. Four point eight metres high. Four metres wide.
>
> Now TomTom calculates the route with these limits. Not a car route — a route for
> this exact vehicle.

`[DO]` Point at the route list.

> Here I get the main route and alternatives. Time, distance, and delay from live
> traffic. Traffic is real and live, not from last year.
>
> And I can compare. This one is faster. This one is longer but maybe better for us.
> The choice stays with the planner. The tool gives the facts.

---

## 5. Bridges and tunnels — the important part (1.5 min)

> Now the part I like most.

`[DO]` Point at **ON THIS ROUTE** in the panel.

> The app looked at my route and found every bridge and every tunnel on it.
>
> Here — Erasmusbrug, a bridge, about six hundred fifty metres long, two point nine
> kilometres from the start. And here, a tunnel.
>
> Why does this matter? A bridge is a weight question. A tunnel is a height question.
> These are exactly the two things that stop a heavy convoy.
>
> Before, a planner had to find this by hand, looking along the line on the map. Now
> it is a list. In seconds.

`[DO]` Point at the pink and green lines on the map.

> On the map you see them too. Pink is a bridge — the road goes over something.
> Green and dashed is a tunnel — the road goes under something.
>
> And this is every bridge and tunnel on the road network, not only the famous ones.
> We take it from the TomTom road data itself.

**If someone asks how accurate it is:**

> We checked it in over forty cities in Europe and America. Bridges and tunnels come
> out correct in about ninety-five percent of cases where we can verify the name in
> the local language. And we tested the big ones directly — Golden Gate, Brooklyn
> Bridge, the Mont Blanc tunnel, the Øresund bridge, the Gotthard tunnel. All correct.

---

## 6. Critical infrastructure (1 min)

`[DO]` Open **Layers**. `[DO]` Turn on a few POI layers.

> Now let me add what is around the route.
>
> Military bases. Fuel. Hospitals and emergency services. Airfields. Ports. Border
> crossings. Rail terminals. Truck stops and rest areas.
>
> This is TomTom's place data, and we use it carefully. Each layer only shows the
> exact official categories. We do not guess and we do not search by text. So a
> "military" layer shows military sites — not a shop with a military name.

`[DO]` Click one POI.

> And if I click any place, I can plan straight to it. Directions, or go. So if I
> need fuel on the way, it takes two clicks.

---

## 7. Terrain (45 sec — optional)

`[DO]` Switch to **3D**.

> One more thing that matters for heavy vehicles: the ground is not flat.
>
> This is real elevation data. Not a drawing — real height. So you see the hills and
> the valleys the route goes through.
>
> For a sixty tonne load, a steep climb is a real problem. The route profile shows
> where the steep parts are.

---

## 8. Drive it (1.5 min)

`[DO]` Click **Start navigation**.

> Now let us drive it.

`[DO]` Let it run for a few seconds.

> This is full turn-by-turn guidance. The instruction on top, the arrival time below.
>
> The vehicle icon changes with the vehicle. This red one is the heavy convoy. You can
> see at one look what is moving.

`[DO]` Click the camera button (◭ / ▦).

> Two camera views. One follows behind the vehicle, like a normal navigation app. One
> looks straight down, so you see more of what is coming.

`[DO]` Point at the satellite ground.

> And notice — we are driving over real satellite imagery, and it is sharp. We load
> the picture of the road ahead before you get there.
>
> It can also use real GPS. So the same screen works on a laptop in a planning room,
> and in a vehicle on the road.

---

## 9. Imagery over time (45 sec — optional)

`[DO]` Open **Imagery timeline**.

> Vantor imagery has a date. So we can ask: show me this place on this day.
>
> This is where it becomes interesting for the future. If you can see the same place
> on two different dates, you can see what changed. A new roadblock. A damaged bridge.
> A new building.
>
> We have built the foundation for this. The dates are there and the comparison is
> prepared. The automatic change detection is the next step, not something I am showing
> you today.

---

## 10. Closing (30 sec)

> So, to finish.
>
> One screen. Vantor shows you the ground as it really is. TomTom gets you across it —
> with your real vehicle, your real limits, and live traffic.
>
> And the thing in the middle, the thing that is new: it tells you about the bridges
> and the tunnels on your route before you drive into them.
>
> Neither company can do this alone. Together it is one tool that answers one question:
> can my convoy get there, and how.
>
> Thank you. I am happy to take questions.

---

## IMPORTANT — two things not to say

**1. Elevation is not Vantor data.** The height data comes from an open source (AWS
Terrain Tiles). We tested the Vantor elevation product and could not use it with this
key. So say "real elevation data" — do **not** say "Vantor elevation". The credit line
at the bottom of the map says the true source, and a technical customer may read it.

**2. Change detection does not work yet.** The dates and the compare button are real.
The automatic "what changed" answer is not built. Section 9 is written to be honest
about this — please keep that wording. If you promise it and they ask for it, that is
a hard conversation later.

---

## Likely questions

**"Is this live traffic or historic?"**
> Live, from TomTom. Including incidents — accidents and closures.

**"Can it route for my specific vehicle?"**
> Yes. Weight, height, length, width, and axle weight. We have four ready profiles and
> you can enter your own numbers.

**"Where does the satellite picture come from?"**
> Vantor. And it has a capture date, so you know how old what you see is.

**"Does it work without internet?"**
> Not today. It needs a connection. Offline packages would be a next step.

**"Is our data safe? Who can see it?"**
> This is a demo, so it is open — no login. The vendor keys stay on the server and
> never reach the browser. For a real deployment, authentication and access control
> would be added.

**"Can it export to ATAK / our command system?"**
> Not today. The route and the bridge and tunnel list are clean data, so an export can
> be added. It is not in this demo.

**"How current are the bridge and tunnel details?"**
> It comes from the TomTom map data, so it updates with their map. One honest limit:
> you need to be zoomed in to city level to see them on the map. That is a limit of the
> map data, not of our app. On a route, they are always listed.

---

## Practical tips

- Have the route **already typed** before you start talking. Do not type live.
- Rotterdam or Amsterdam is a good demo city — many bridges and tunnels in a small area.
- Zoom to **city level** before you talk about bridges, or they will not be on screen.
- Let the navigation run for ten seconds in silence. It looks good. Let them watch.
- If the internet is slow, the satellite picture loads slowly. Say "this is loading the
  real imagery" — do not apologise, explain.
