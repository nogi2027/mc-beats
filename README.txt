# MC Beats

## Inspiration

MC Beats began as an investigation into human-agent interaction. As a musician, one of the most interesting forms of interaction I experience is playing music with other people. When I perform with someone, I am always listening, reacting, and looking for small cues that help me understand what they are doing.

I wanted to explore what that relationship could look like with an AI agent. Could I build an instrument where I could play with an agent, respond to its ideas, and let it respond to mine?

## What it does

MC Beats is a browser-based live synthesizer and two-deck performance tool. I can play drums, bass, chords, and lead; record loops; shape each sound; and move between two four-bar decks.

At the same time, a WebMCP agent can read the musical state, follow what I am playing, prepare new material, arrange patterns, schedule transfers, and perform solos. This lets me play while the agent works in the background, then respond when it brings a new idea into the performance.

Everything runs on one shared musical clock. The agent queues its actions to beats and bars, so its changes fit the timing of the music. The interface shows what is on each deck, what is playing, and what the agent is doing, which helps me understand the performance at a glance.

Every sound is generated in the browser using oscillators, filters, envelopes, effects, and procedural noise. There are no recorded samples or backend music services.

## How I built it

I built MC Beats in three main stages.

I started with the synthesizer. I set myself the challenge of generating every sound from basic waveforms, such as sine and saw waves, along with random noise. It took a couple of days to get the synth sounding good. I spent much of that time adjusting the values for each instrument until the drums, bass, chords, and lead sounded the way I wanted.

Next, I designed the interface. I first sketched it by hand, drawing some inspiration from instruments such as the OP-1. I wanted it to feel like a physical music tool while still making sense as a web app. I then gave it my own visual style, with two decks, clear instrument colours, playable controls, and a compact layout.

The third stage was the WebMCP integration. I connected the interface and synthesizer to tools that let an agent understand the current performance and take musical actions. This was the point when the separate parts came together and began to feel like one instrument.

## Challenges

The hardest problem was timing. Agents work across two conflicting time scales. Once an agent makes a tool call, the action can happen almost instantly. However, listening to the music, processing the available information, and deciding what to do can take longer than it takes me to reach the next bar.

In my first implementation, the agent queued every action at an exact musical time. Calls sometimes failed because they were formatted incorrectly. Other calls arrived after their requested time had already passed. Each failure meant another tool call, more thinking, and another delay in the music.

I worked on this from both sides. I built higher-level WebMCP tools that give the agent more context and let it complete useful musical tasks in fewer calls. I also gave it clearer information about the current bar and the earliest safe time for its next action. One experiment was to tell the agent how many tokens it could use during each bar, encouraging it to make faster decisions.

I also let the agent schedule actions across several bars. A single tool call can prepare a phrase, arrange a deck, or plan a transfer that unfolds over time. This helps the agent’s actions fit the pace of a live performance.

The second challenge was communication. When I play with other musicians, I use eye contact, movement, and other small signals to understand what they are about to do. Those cues do not naturally exist when I play with an agent.

I tried to recreate some of that awareness through the interface. My actions and the agent’s actions use a similar visual language. A control bar shows what the agent is doing, and the deck displays let me see the current state of the music. In the other direction, WebMCP tools give the agent structured information about the key, transport, deck contents, and what I have recently played.

## What I learned

Building MC Beats taught me how much good collaboration depends on timing and shared information. Giving an agent control is easy compared with helping it understand when to act, what I am doing, and how to show me what it plans to do.

I found that an agent works best as a musical partner when it can listen, prepare ideas in the background, enter at a useful moment, and leave enough space for me to respond.
