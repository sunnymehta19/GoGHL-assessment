Prompt 1: 

I'm doing a 2-hour timed build assessment. Stack: Node.js, React, MongoDB, Redis.
The brief is in [file]. A checker in [folder] will test my server under failure
conditions: bad network, process kill and restart, multiple instances at once.

Rules for this session:
1. Before writing code, read the brief and give me a short plan: what to build
   first, what to cut, and the key decisions. Wait for my OK.
2. Build in small steps. After each step, tell me what changed and how to test it.
3. Design for failure: persist state in MongoDB (not memory), use idempotency
   keys for anything that charges, sends or creates, add timeouts and retries
   with backoff for external calls, use unique indexes and atomic updates, and
   use Redis for anything shared across instances.
4. Never edit the checker. Never hardcode behaviour to pass a test.
5. Keep the code simple enough that I can explain every line.
6. If something in the brief is ambiguous, list your assumption so I can
   record it in the decisions note.



Prompt 2:

do the step 1 only and stop for you to test


Prompt 3: 

start step 2

Prompt 4: 

