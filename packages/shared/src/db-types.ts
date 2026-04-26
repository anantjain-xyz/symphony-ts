export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      agent_events: {
        Row: {
          created_at: string
          id: number
          kind: Database["public"]["Enums"]["agent_event_kind"]
          payload: Json
          run_id: string
        }
        Insert: {
          created_at?: string
          id?: number
          kind: Database["public"]["Enums"]["agent_event_kind"]
          payload: Json
          run_id: string
        }
        Update: {
          created_at?: string
          id?: number
          kind?: Database["public"]["Enums"]["agent_event_kind"]
          payload?: Json
          run_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_events_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
        ]
      }
      hook_runs: {
        Row: {
          created_at: string
          duration_ms: number
          exit_code: number
          hook: Database["public"]["Enums"]["hook_name"]
          id: number
          run_id: string | null
          stderr_tail: string | null
        }
        Insert: {
          created_at?: string
          duration_ms: number
          exit_code: number
          hook: Database["public"]["Enums"]["hook_name"]
          id?: number
          run_id?: string | null
          stderr_tail?: string | null
        }
        Update: {
          created_at?: string
          duration_ms?: number
          exit_code?: number
          hook?: Database["public"]["Enums"]["hook_name"]
          id?: number
          run_id?: string | null
          stderr_tail?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "hook_runs_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
        ]
      }
      issues: {
        Row: {
          blockers: string[]
          branch: string | null
          description: string | null
          id: string
          identifier: string
          labels: string[]
          last_seen_at: string
          pr_urls: string[]
          priority: number
          raw: Json
          state: string
          title: string
        }
        Insert: {
          blockers?: string[]
          branch?: string | null
          description?: string | null
          id: string
          identifier: string
          labels?: string[]
          last_seen_at?: string
          pr_urls?: string[]
          priority?: number
          raw: Json
          state: string
          title: string
        }
        Update: {
          blockers?: string[]
          branch?: string | null
          description?: string | null
          id?: string
          identifier?: string
          labels?: string[]
          last_seen_at?: string
          pr_urls?: string[]
          priority?: number
          raw?: Json
          state?: string
          title?: string
        }
        Relationships: []
      }
      live_sessions: {
        Row: {
          input_tokens: number
          last_event_at: string
          output_tokens: number
          run_id: string
          session_id: string
          started_at: string
          thread_id: string
          total_tokens: number
          turn_id: string
        }
        Insert: {
          input_tokens?: number
          last_event_at?: string
          output_tokens?: number
          run_id: string
          session_id: string
          started_at?: string
          thread_id: string
          total_tokens?: number
          turn_id: string
        }
        Update: {
          input_tokens?: number
          last_event_at?: string
          output_tokens?: number
          run_id?: string
          session_id?: string
          started_at?: string
          thread_id?: string
          total_tokens?: number
          turn_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "live_sessions_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: true
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
        ]
      }
      rate_limit_state: {
        Row: {
          remaining: number | null
          reset_at: string | null
          source: string
          updated_at: string
        }
        Insert: {
          remaining?: number | null
          reset_at?: string | null
          source: string
          updated_at?: string
        }
        Update: {
          remaining?: number | null
          reset_at?: string | null
          source?: string
          updated_at?: string
        }
        Relationships: []
      }
      retry_queue: {
        Row: {
          created_at: string
          due_at: string
          error_class: string | null
          error_message: string | null
          issue_id: string
          run_number: number
        }
        Insert: {
          created_at?: string
          due_at: string
          error_class?: string | null
          error_message?: string | null
          issue_id: string
          run_number: number
        }
        Update: {
          created_at?: string
          due_at?: string
          error_class?: string | null
          error_message?: string | null
          issue_id?: string
          run_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "retry_queue_issue_id_fkey"
            columns: ["issue_id"]
            isOneToOne: true
            referencedRelation: "issues"
            referencedColumns: ["id"]
          },
        ]
      }
      runs: {
        Row: {
          created_at: string
          ended_at: string | null
          error_class: string | null
          error_message: string | null
          id: string
          issue_id: string
          run_number: number
          started_at: string | null
          status: Database["public"]["Enums"]["run_status"]
          worker_pid: number | null
          workspace_path: string
        }
        Insert: {
          created_at?: string
          ended_at?: string | null
          error_class?: string | null
          error_message?: string | null
          id?: string
          issue_id: string
          run_number: number
          started_at?: string | null
          status?: Database["public"]["Enums"]["run_status"]
          worker_pid?: number | null
          workspace_path: string
        }
        Update: {
          created_at?: string
          ended_at?: string | null
          error_class?: string | null
          error_message?: string | null
          id?: string
          issue_id?: string
          run_number?: number
          started_at?: string | null
          status?: Database["public"]["Enums"]["run_status"]
          worker_pid?: number | null
          workspace_path?: string
        }
        Relationships: [
          {
            foreignKeyName: "runs_issue_id_fkey"
            columns: ["issue_id"]
            isOneToOne: false
            referencedRelation: "issues"
            referencedColumns: ["id"]
          },
        ]
      }
      worker_heartbeat: {
        Row: {
          id: string
          last_beat_at: string
          started_at: string
          worker_pid: number | null
        }
        Insert: {
          id?: string
          last_beat_at?: string
          started_at: string
          worker_pid?: number | null
        }
        Update: {
          id?: string
          last_beat_at?: string
          started_at?: string
          worker_pid?: number | null
        }
        Relationships: []
      }
      workflows: {
        Row: {
          id: string
          loaded_at: string
          parsed: Json
          prompt_template: string
          source_hash: string
        }
        Insert: {
          id?: string
          loaded_at?: string
          parsed: Json
          prompt_template: string
          source_hash: string
        }
        Update: {
          id?: string
          loaded_at?: string
          parsed?: Json
          prompt_template?: string
          source_hash?: string
        }
        Relationships: []
      }
    }
    Views: {
      agent_events_latest: {
        Row: {
          created_at: string | null
          id: number | null
          kind: Database["public"]["Enums"]["agent_event_kind"] | null
          payload: Json | null
          run_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_events_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      agent_event_kind:
        | "status"
        | "tool_call"
        | "approval"
        | "token_count"
        | "error"
        | "user_input"
        | "humanized"
        | "rate_limit"
      hook_name: "after_create" | "before_run" | "after_run" | "before_remove"
      run_status:
        | "pending"
        | "running"
        | "success"
        | "failure"
        | "timeout"
        | "cancelled"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      agent_event_kind: [
        "status",
        "tool_call",
        "approval",
        "token_count",
        "error",
        "user_input",
        "humanized",
        "rate_limit",
      ],
      hook_name: ["after_create", "before_run", "after_run", "before_remove"],
      run_status: [
        "pending",
        "running",
        "success",
        "failure",
        "timeout",
        "cancelled",
      ],
    },
  },
} as const

