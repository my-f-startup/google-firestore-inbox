Feature: Clean up handled messages
  As a service owner
  I want the records of handled messages to be removed after a while
  So that the inbox does not grow forever and still catches late duplicates

  Scenario: A done record has the expiry date of the TTL policy
    Given a message that was handled
    Then its record has an expiry date, stored as a Firestore timestamp

  Scenario: A processing record does not expire
    Given a message whose handling was interrupted
    Then its record has no expiry date

  Scenario: The expiry is configurable
    Given an inbox with its own expiry
    When a message is handled
    Then the expiry date of its record follows that expiry
