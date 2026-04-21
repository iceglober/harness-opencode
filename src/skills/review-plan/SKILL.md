---
name: review-plan
description: After changes are made to a plan, review for inconsistencies in structure, concepts, or terminology that may derail the implementation
---

# Review Plan Skill

## Instructions

1. Review the recently updated plan file for consistency in language used and concepts described.
2. Identify problematic areas of ambiguity in the plan that may cause issues in implementation.
3. If inconsistencies or ambiguity are identified, present the user with questions to clear things up.

## Examples

### Example 1

In the beginning of the plan file, in an overview section, we see a summary that says:

```
The new endpoint will be POST /requests/queue and it will create both the Request and Tracker resource
```

But at the end of the plan file in implementation examples we see:

```
curl -X POST http://localhost:3001/requests/add
// Get request and tracker IDs back
```

This is a clear inconsistency in language and structure. In this case, we'd ask the user what the intended
path is for the new endpoint.
