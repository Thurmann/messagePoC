# Local architecture

```text
POST /api/messages
        |
        v
  message-api -- MessageSubmitted --> poc.messages.submitted.v1
                                           |
                                           v
                                  validation-service
                                           |
                          +----------------+----------------+
                          |                                 |
                  MessageValidated                 MessageRejected
                          +----------------+----------------+
                                           |
                                           v
                                 poc.messages.results.v1
                                           |
                                           v
                                      message-view
                                      terminal log
```

`messageId` is used as the Kafka record key so all events for one message are
routed to the same partition. A rejected message is a business result and is
therefore published as an event; the DLT is reserved for technical failures in
a later milestone.
