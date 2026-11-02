variable "project" {
  description = "Name used when this stub is later filled in for a real host."
  type        = string
  default     = "hearth"
}

variable "database_url" {
  description = "Postgres connection string for a future managed database. Unused locally."
  type        = string
  sensitive   = true
  default     = ""
}
