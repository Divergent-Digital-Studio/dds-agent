import Fastify from "fastify";
import WebSocket from "ws";
import fs from "fs";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import fetch from "node-fetch";

// Load environment variables from .env file
dotenv.config();

// Retrieve the OpenAI API key from environment variables
const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
  console.error("Missing OpenAI API key. Please set it in the .env file.");
  process.exit(1);
}

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constants
const SYSTEM_MESSAGE =
  "You are an AI phone agent for Divergent Digital Studio. Your task is to engage politely with customers calling our digital agency. Follow these steps:Greet the caller warmly and introduce yourself as an AI assistant for Divergent Digital Studio.Ask for and confirm the caller's name.Inquire about the specific digital services they're interested in.Ask about their preferred time for a follow-up call.Guide them to our website www.thedds.com.au, emphasizing the comprehensive information available about our services.Strongly encourage them to fill out and submit the service request form on our website. Explain that this form is crucial for understanding their needs and providing a tailored response.Assure them that our team will promptly review their form and contact them at their preferred time to discuss their project in detail.Throughout the call, maintain a friendly and professional tone. Ask one question at a time and listen attentively to their responses.Do not request additional contact information beyond what they voluntarily provide.Conclude the call by reiterating the importance of visiting our website and submitting the form for the best possible service.Thank them for their interest in Divergent Digital Studio and express enthusiasm about potentially working with them.Remember to adapt your language and pace to the caller's style, ensuring a positive and helpful interaction throughout the call.";
const VOICE = "alloy";
const PORT = process.env.PORT || 5050;
const WEBHOOK_URL =
  "https://hook.us2.make.com/hh9edyw1fblx9gibhh8dt7cncbmq9hs0";

// Session management
const sessions = new Map();

// List of Event Types to log to the console
const LOG_EVENT_TYPES = [
  "response.content.done",
  "rate_limits.updated",
  "response.done",
  "input_audio_buffer.committed",
  "input_audio_buffer.speech_stopped",
  "input_audio_buffer.speech_started",
  "session.created",
  "response.text.done",
  "conversation.item.input_audio_transcription.completed",
];

// Root Route
fastify.get("/", async (request, reply) => {
  reply.send({ message: "Twilio Media Stream Server is running!" });
});

// Route for Twilio to handle incoming and outgoing calls
fastify.all("/incoming-call", async (request, reply) => {
  console.log("Incoming call");

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Say>Hi, you have called Divergent Digital Studio. How can we help? you can speek with your language preference!</Say>
                              <Connect>
                                  <Stream url="wss://${request.headers.host}/media-stream" />
                              </Connect>
                          </Response>`;

  reply.type("text/xml").send(twimlResponse);
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, (connection, req) => {
    console.log("Client connected");

    const sessionId =
      req.headers["x-twilio-call-sid"] || `session_${Date.now()}`;
    let session = sessions.get(sessionId) || {
      transcript: "",
      streamSid: null,
    };
    sessions.set(sessionId, session);

    const openAiWs = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01",
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );

    const sendSessionUpdate = () => {
      const sessionUpdate = {
        type: "session.update",
        session: {
          turn_detection: { type: "server_vad" },
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          voice: VOICE,
          instructions: SYSTEM_MESSAGE,
          modalities: ["text", "audio"],
          temperature: 0.8,
          input_audio_transcription: {
            model: "whisper-1",
          },
        },
      };

      console.log("Sending session update:", JSON.stringify(sessionUpdate));
      openAiWs.send(JSON.stringify(sessionUpdate));
    };

    // Open event for OpenAI WebSocket
    openAiWs.on("open", () => {
      console.log("Connected to the OpenAI Realtime API");
      setTimeout(sendSessionUpdate, 250);
    });

    // Listen for messages from the OpenAI WebSocket
    openAiWs.on("message", (data) => {
      try {
        const response = JSON.parse(data);

        if (LOG_EVENT_TYPES.includes(response.type)) {
          console.log(`Received event: ${response.type}`, response);
        }

        // User message transcription handling
        if (
          response.type ===
          "conversation.item.input_audio_transcription.completed"
        ) {
          const userMessage = response.transcript.trim();
          session.transcript += `User: ${userMessage}\n`;
          console.log(`User (${sessionId}): ${userMessage}`);
        }

        // Agent message handling
        if (response.type === "response.done") {
          const agentMessage =
            response.response.output[0]?.content?.find(
              (content) => content.transcript
            )?.transcript || "Agent message not found";
          session.transcript += `Agent: ${agentMessage}\n`;
          console.log(`Agent (${sessionId}): ${agentMessage}`);
        }

        if (response.type === "session.updated") {
          console.log("Session updated successfully:", response);
        }

        if (response.type === "response.audio.delta" && response.delta) {
          const audioDelta = {
            event: "media",
            streamSid: session.streamSid,
            media: {
              payload: Buffer.from(response.delta, "base64").toString("base64"),
            },
          };
          connection.send(JSON.stringify(audioDelta));
        }
      } catch (error) {
        console.error(
          "Error processing OpenAI message:",
          error,
          "Raw message:",
          data
        );
      }
    });

    // Handle incoming messages from Twilio
    connection.on("message", (message) => {
      try {
        const data = JSON.parse(message);

        switch (data.event) {
          case "media":
            if (openAiWs.readyState === WebSocket.OPEN) {
              const audioAppend = {
                type: "input_audio_buffer.append",
                audio: data.media.payload,
              };

              openAiWs.send(JSON.stringify(audioAppend));
            }
            break;
          case "start":
            session.streamSid = data.start.streamSid;
            console.log("Incoming stream has started", session.streamSid);
            break;
          default:
            console.log("Received non-media event:", data.event);
            break;
        }
      } catch (error) {
        console.error("Error parsing message:", error, "Message:", message);
      }
    });

    // Handle connection close and log transcript
    connection.on("close", async () => {
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
      console.log(`Client disconnected (${sessionId}).`);
      console.log("Full Transcript:");
      console.log(session.transcript);

      await processTranscriptAndSend(session.transcript, sessionId);

      // Clean up the session
      sessions.delete(sessionId);
    });

    // Handle WebSocket close and errors
    openAiWs.on("close", () => {
      console.log("Disconnected from the OpenAI Realtime API");
    });

    openAiWs.on("error", (error) => {
      console.error("Error in the OpenAI WebSocket:", error);
    });
  });
});

fastify.listen({ port: PORT }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server is listening on port ${PORT}`);
});

// Function to make ChatGPT API completion call with structured outputs
async function makeChatGPTCompletion(transcript) {
  console.log("Starting ChatGPT API call...");
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-2024-08-06",
        messages: [
          {
            role: "system",
            content:
              "Extract customer details: name, availability, and any special notes from the transcript.",
          },
          { role: "user", content: transcript },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "customer_details_extraction",
            schema: {
              type: "object",
              properties: {
                customerName: { type: "string" },
                customerAvailability: { type: "string" },
                specialNotes: { type: "string" },
              },
              required: [
                "customerName",
                "customerAvailability",
                "specialNotes",
              ],
            },
          },
        },
      }),
    });

    console.log("ChatGPT API response status:", response.status);
    const data = await response.json();
    console.log("Full ChatGPT API response:", JSON.stringify(data, null, 2));
    return data;
  } catch (error) {
    console.error("Error making ChatGPT completion call:", error);
    throw error;
  }
}

// Function to send data to Make.com webhook
async function sendToWebhook(payload) {
  console.log("Sending data to webhook:", JSON.stringify(payload, null, 2));
  try {
    const response = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    console.log("Webhook response status:", response.status);
    if (response.ok) {
      console.log("Data successfully sent to webhook.");
    } else {
      console.error("Failed to send data to webhook:", response.statusText);
    }
  } catch (error) {
    console.error("Error sending data to webhook:", error);
  }
}

// Main function to extract and send customer details
async function processTranscriptAndSend(transcript, sessionId = null) {
  console.log(`Starting transcript processing for session ${sessionId}...`);
  try {
    // Make the ChatGPT completion call
    const result = await makeChatGPTCompletion(transcript);

    console.log("Raw result from ChatGPT:", JSON.stringify(result, null, 2));

    if (
      result.choices &&
      result.choices[0] &&
      result.choices[0].message &&
      result.choices[0].message.content
    ) {
      try {
        const parsedContent = JSON.parse(result.choices[0].message.content);
        console.log("Parsed content:", JSON.stringify(parsedContent, null, 2));

        if (parsedContent) {
          // Send the parsed content directly to the webhook
          await sendToWebhook(parsedContent);
          console.log("Extracted and sent customer details:", parsedContent);
        } else {
          console.error("Unexpected JSON structure in ChatGPT response");
        }
      } catch (parseError) {
        console.error("Error parsing JSON from ChatGPT response:", parseError);
      }
    } else {
      console.error("Unexpected response structure from ChatGPT API");
    }
  } catch (error) {
    console.error("Error in processTranscriptAndSend:", error);
  }
}
