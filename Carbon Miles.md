# Carbon Miles – Product Planning & Architecture Prompt

You are a Principal Product Manager, Solution Architect, Staff Software Engineer, Data Engineer, UX Designer, and AI Systems Architect.

Your task is to create a complete implementation plan for a software product called **Carbon Miles**.

Do not write code initially. Focus on product strategy, system architecture, database design, data acquisition strategy, AI architecture, scalability, user experience, compliance considerations, and phased implementation planning.

## Product Overview

Carbon Miles is a mobility intelligence platform designed for the Indian market.

The platform helps users:

### 1. Find the Most Suitable Vehicle

Recommend the best vehicle for an individual or business based on:

- Daily running distance
- Monthly running distance
- Typical trip length
- City/highway usage ratio
- Passenger count
- Cargo requirements
- Ownership duration
- Budget
- State and city
- Availability of:
  - EV chargers
  - CNG stations
  - Petrol pumps
  - Diesel pumps
  - Hydrogen stations (future)
- Environmental preferences
- TCO (Total Cost of Ownership)
- Financing preferences

Vehicle recommendations must support:

#### Passenger Vehicles

- Hatchbacks
- Sedans
- SUVs
- MPVs
- Two-wheelers
- Three-wheelers
- Electric vehicles

#### Commercial Vehicles

- Delivery vehicles
- LCVs
- MCVs
- HCVs
- Buses
- Fleet vehicles
- Last-mile mobility vehicles

Recommendations should consider:

- Purchase price
- Fuel cost
- Maintenance cost
- Battery replacement cost
- Resale value
- Annual running
- ROI
- Break-even period
- Carbon impact

The output should explain WHY a vehicle is recommended.

---

### 2. E20 Compatibility & Impact Advisor

Users can select their existing vehicle.

The system should determine:

- Whether the vehicle is E20 compliant
- Expected impact of E20 fuel usage
- Mileage degradation estimates
- Maintenance implications
- Potential engine wear concerns
- Long-term ownership impact

The system should provide practical recommendations such as:

- Fuel usage practices
- Service intervals
- Component inspections
- Driving habits
- Preventive maintenance
- Upgrade recommendations

The output must be educational and evidence-backed.

---

## Key Business Principle

The AI assistant should NOT perform internet searches during conversations.

Instead:

1. Vehicle data should be collected and stored beforehand.
2. AI should use the internal knowledge base.
3. Minimize token usage.
4. Minimize API costs.
5. Use RAG or structured retrieval before invoking LLMs.
6. Claude Haiku should only generate explanations and recommendations.
7. Vehicle specifications should come from the database.

---

# Data Strategy

Design a data acquisition strategy for collecting and maintaining:

## Vehicle Information

For every Indian vehicle, including:

- Active models
- Discontinued models
- Upcoming models (optional future phase)

Across:

- Petrol
- Diesel
- CNG
- EV
- Hybrid
- Hydrogen

Store:

- Manufacturer
- Brand
- Model
- Variant
- Fuel type
- Launch year
- Discontinuation year
- Engine specifications
- Battery specifications
- Range
- Mileage
- Charging speed
- Payload
- Seating capacity
- Ex-showroom price
- Typical maintenance cost
- Reliability indicators
- Common problems
- Known advantages
- Known disadvantages
- E20 compatibility information

Propose:

- Scraping architecture
- Update frequency
- Source ranking
- Data validation workflow
- Data quality scoring

---

# AI Architecture

Design a cost-efficient AI architecture.

Requirements:

- Claude Haiku API
- Low token consumption
- No live web searching
- High recommendation quality

The assistant should:

1. Understand user intent.
2. Extract structured inputs.
3. Query internal databases.
4. Retrieve relevant vehicle records.
5. Generate recommendations.

Design:

- RAG flow
- Embedding strategy
- Vector database strategy
- Caching strategy
- Retrieval workflow
- Recommendation workflow

Explain:

- When an LLM is needed
- When an LLM should NOT be used

---

# Product Experience

The product will be a PWA.

Requirements:

- Responsive design
- Mobile-first
- Tablet support
- Desktop support

Create detailed user journeys for:

## User Journey A

Vehicle Purchase Advisor

From:

Landing Page

To:

Final Recommendation

Including:

- Questionnaire
- AI interaction
- Recommendation screen
- Comparison screen
- Report generation

---

## User Journey B

E20 Compatibility Advisor

From:

Vehicle Selection

To:

Impact Assessment

To:

Improvement Recommendations

---

# Authentication

Simple authentication:

- Email login
- OTP login
- Social login (future phase)

Design:

- User model
- Session model
- Saved reports
- Saved vehicles
- Recommendation history

---

# Database Design

Create a detailed database schema including:

- Users
- Vehicles
- Variants
- Fuel types
- Manufacturers
- Vehicle specifications
- E20 compatibility data
- Fuel economy data
- Charging infrastructure
- Fuel infrastructure
- Recommendation history
- Saved reports

Recommend:

- PostgreSQL schema
- Indexing strategy
- Search strategy

---

# Recommendation Engine

Design recommendation algorithms for:

## Passenger Vehicles

Factors:

- Cost
- Usage
- Infrastructure
- Environmental impact
- Ownership duration

---

## Commercial Vehicles

Factors:

- Payload
- Daily running
- Fuel economics
- Profitability
- Financing

Output:

- Scoring methodology
- Weighting methodology
- Explainability framework

---

# Admin Panel

Design an admin portal to:

- Manage vehicles
- Review scraped data
- Approve updates
- Monitor scraping jobs
- Manage knowledge base entries
- Review recommendation logs

---

# Non-Functional Requirements

Target:

- 100,000 users
- 1 million vehicle recommendation requests
- Low operational cost

Design:

- Scalability strategy
- Caching strategy
- Infrastructure architecture
- Monitoring architecture

---

# Deliverables

Produce:

1. Product Requirements Document (PRD)
2. System Architecture
3. Database Design
4. Data Scraping Strategy
5. AI/RAG Architecture
6. API Design
7. User Flow Diagrams
8. Admin Flow Diagrams
9. Recommendation Engine Design
10. Development Roadmap

Finally, provide:

- MVP Scope
- Phase 2 Scope
- Phase 3 Scope
- Estimated development effort
- Recommended technology stack
- Major risks and mitigation plans

Challenge assumptions where necessary and suggest better approaches if they improve accuracy, scalability, maintainability, cost, or user experience.