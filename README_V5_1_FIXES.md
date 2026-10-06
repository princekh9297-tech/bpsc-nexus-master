# BPSC Nexus V5.1 UI/UX + Runtime Fixes

## Fixed
- Replaced the overlapping 7-button fixed command hub with a responsive 5-item command dock.
- Added a non-overlapping More menu for Alerts, Support and Admin.
- Added safe-area-aware mobile positioning.
- Raised quiz action controls above the command dock on phones.
- Fixed a malformed mobile CSS declaration in the Dhyeya migration layer.
- Unified the six Dhyeya themes with the active body theme so text/surfaces retain readable contrast.
- Forced subject-card text to remain readable on dark subject artwork.
- Restyled advanced feature modals to use the Dhyeya warm editorial palette.
- Feature API failures now open a visible retry dialog instead of appearing to do nothing.
- Existing question records remain untouched.

## Data
- All 8 records-*.js files are preserved byte-for-byte.
- Existing PostgreSQL schema initialization remains enabled.
- Planner uses device-local calendar dates.
