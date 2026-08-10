// GENERATED FILE — do not edit by hand.
// Regenerate: npm run gen:types            (linked project)
//             npm run gen:types -- --local (running `supabase start` stack)
//
// The Postgres schema as TypeScript. Its value is not documentation — it is that
// a column name typed wrong stops compiling instead of failing at runtime, which
// is how jobs.ready_to_invoice reached production referenced by nine call sites
// and existing in no database.
//
// tests/unit/database-types-freshness.test.ts fails the build when a migration
// adds something this file has not caught up with, so a stale copy cannot sit
// here looking authoritative.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      backflow_devices: {
        Row: {
          created_at: string | null
          created_by: string | null
          customer_id: string
          device_type: string
          fire_service_meter_number: string | null
          id: string
          is_active: boolean
          location_description: string | null
          make: string | null
          model: string | null
          notes: string | null
          protection_type: string | null
          serial_number: string | null
          site_id: string | null
          size_mm: number | null
          test_frequency_months: number
          updated_at: string | null
          water_authority: string
          water_authority_property_number: string | null
          water_meter_number: string | null
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          customer_id: string
          device_type: string
          fire_service_meter_number?: string | null
          id?: string
          is_active?: boolean
          location_description?: string | null
          make?: string | null
          model?: string | null
          notes?: string | null
          protection_type?: string | null
          serial_number?: string | null
          site_id?: string | null
          size_mm?: number | null
          test_frequency_months?: number
          updated_at?: string | null
          water_authority: string
          water_authority_property_number?: string | null
          water_meter_number?: string | null
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          customer_id?: string
          device_type?: string
          fire_service_meter_number?: string | null
          id?: string
          is_active?: boolean
          location_description?: string | null
          make?: string | null
          model?: string | null
          notes?: string | null
          protection_type?: string | null
          serial_number?: string | null
          site_id?: string | null
          size_mm?: number | null
          test_frequency_months?: number
          updated_at?: string | null
          water_authority?: string
          water_authority_property_number?: string | null
          water_meter_number?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "backflow_devices_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "backflow_devices_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "backflow_devices_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: false
            referencedRelation: "sites"
            referencedColumns: ["id"]
          },
        ]
      }
      backflow_tests: {
        Row: {
          certificate_storage_path: string | null
          complies_with_as_nzs_3500_1: boolean | null
          created_at: string | null
          device_id: string
          id: string
          isolating_valves_padlocked: boolean | null
          job_id: string | null
          mains_pressure_kpa: number | null
          permission_to_turn_off_water: boolean | null
          reason_for_failure: string | null
          remarks: string | null
          repair_scheduled_date: string | null
          result: string
          signature_storage_path: string | null
          strainer_cleaned: boolean | null
          strainer_installed: boolean | null
          submitted_to_email: string | null
          submitted_to_water_authority_at: string | null
          test_date: string
          test_kit_calibration_date: string | null
          test_kit_serial_number: string | null
          test_results: Json
          test_type: string
          tested_by: string | null
          tester_licence_number: string | null
          tester_name: string
          tester_phone: string | null
        }
        Insert: {
          certificate_storage_path?: string | null
          complies_with_as_nzs_3500_1?: boolean | null
          created_at?: string | null
          device_id: string
          id?: string
          isolating_valves_padlocked?: boolean | null
          job_id?: string | null
          mains_pressure_kpa?: number | null
          permission_to_turn_off_water?: boolean | null
          reason_for_failure?: string | null
          remarks?: string | null
          repair_scheduled_date?: string | null
          result: string
          signature_storage_path?: string | null
          strainer_cleaned?: boolean | null
          strainer_installed?: boolean | null
          submitted_to_email?: string | null
          submitted_to_water_authority_at?: string | null
          test_date?: string
          test_kit_calibration_date?: string | null
          test_kit_serial_number?: string | null
          test_results?: Json
          test_type: string
          tested_by?: string | null
          tester_licence_number?: string | null
          tester_name: string
          tester_phone?: string | null
        }
        Update: {
          certificate_storage_path?: string | null
          complies_with_as_nzs_3500_1?: boolean | null
          created_at?: string | null
          device_id?: string
          id?: string
          isolating_valves_padlocked?: boolean | null
          job_id?: string | null
          mains_pressure_kpa?: number | null
          permission_to_turn_off_water?: boolean | null
          reason_for_failure?: string | null
          remarks?: string | null
          repair_scheduled_date?: string | null
          result?: string
          signature_storage_path?: string | null
          strainer_cleaned?: boolean | null
          strainer_installed?: boolean | null
          submitted_to_email?: string | null
          submitted_to_water_authority_at?: string | null
          test_date?: string
          test_kit_calibration_date?: string | null
          test_kit_serial_number?: string | null
          test_results?: Json
          test_type?: string
          tested_by?: string | null
          tester_licence_number?: string | null
          tester_name?: string
          tester_phone?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "backflow_tests_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "backflow_devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "backflow_tests_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "backflow_tests_tested_by_fkey"
            columns: ["tested_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_rate_config: {
        Row: {
          apprentice_margin_pct: number
          call_out_fee: number
          double_time_multiplier: number
          id: boolean
          min_margin_pct: number
          qualified_base_rate: number
          time_and_half_multiplier: number
          updated_at: string | null
          updated_by: string | null
        }
        Insert: {
          apprentice_margin_pct?: number
          call_out_fee?: number
          double_time_multiplier?: number
          id?: boolean
          min_margin_pct?: number
          qualified_base_rate?: number
          time_and_half_multiplier?: number
          updated_at?: string | null
          updated_by?: string | null
        }
        Update: {
          apprentice_margin_pct?: number
          call_out_fee?: number
          double_time_multiplier?: number
          id?: boolean
          min_margin_pct?: number
          qualified_base_rate?: number
          time_and_half_multiplier?: number
          updated_at?: string | null
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "billing_rate_config_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      cost_center_templates: {
        Row: {
          code: string | null
          created_at: string | null
          group_name: string
          id: string
          is_active: boolean
          name: string
          sort_order: number
        }
        Insert: {
          code?: string | null
          created_at?: string | null
          group_name: string
          id?: string
          is_active?: boolean
          name: string
          sort_order?: number
        }
        Update: {
          code?: string | null
          created_at?: string | null
          group_name?: string
          id?: string
          is_active?: boolean
          name?: string
          sort_order?: number
        }
        Relationships: []
      }
      customers: {
        Row: {
          abn: string | null
          company: string | null
          created_at: string | null
          created_by: string | null
          email: string | null
          id: string
          is_active: boolean | null
          is_favorite: boolean
          mobile: string | null
          name: string
          needs_review: boolean | null
          notes: string | null
          phone: string | null
          simpro_customer_id: number | null
          updated_at: string | null
        }
        Insert: {
          abn?: string | null
          company?: string | null
          created_at?: string | null
          created_by?: string | null
          email?: string | null
          id?: string
          is_active?: boolean | null
          is_favorite?: boolean
          mobile?: string | null
          name: string
          needs_review?: boolean | null
          notes?: string | null
          phone?: string | null
          simpro_customer_id?: number | null
          updated_at?: string | null
        }
        Update: {
          abn?: string | null
          company?: string | null
          created_at?: string | null
          created_by?: string | null
          email?: string | null
          id?: string
          is_active?: boolean | null
          is_favorite?: boolean
          mobile?: string | null
          name?: string
          needs_review?: boolean | null
          notes?: string | null
          phone?: string | null
          simpro_customer_id?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "customers_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      device_tokens: {
        Row: {
          platform: string
          token: string
          updated_at: string
          user_id: string
        }
        Insert: {
          platform: string
          token: string
          updated_at?: string
          user_id: string
        }
        Update: {
          platform?: string
          token?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "device_tokens_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      equipment: {
        Row: {
          assigned_to: string | null
          category: string
          created_at: string | null
          estimated_life_years: number
          fuel_cost_per_hour: number
          id: string
          insurance_annual: number
          is_active: boolean
          maintenance_annual: number
          name: string
          notes: string | null
          other_annual_costs: number
          purchase_cost: number
          purchase_date: string | null
          registration: string | null
          registration_annual: number
          target_hours_per_year: number
          updated_at: string | null
          updated_by: string | null
        }
        Insert: {
          assigned_to?: string | null
          category?: string
          created_at?: string | null
          estimated_life_years?: number
          fuel_cost_per_hour?: number
          id?: string
          insurance_annual?: number
          is_active?: boolean
          maintenance_annual?: number
          name: string
          notes?: string | null
          other_annual_costs?: number
          purchase_cost?: number
          purchase_date?: string | null
          registration?: string | null
          registration_annual?: number
          target_hours_per_year?: number
          updated_at?: string | null
          updated_by?: string | null
        }
        Update: {
          assigned_to?: string | null
          category?: string
          created_at?: string | null
          estimated_life_years?: number
          fuel_cost_per_hour?: number
          id?: string
          insurance_annual?: number
          is_active?: boolean
          maintenance_annual?: number
          name?: string
          notes?: string | null
          other_annual_costs?: number
          purchase_cost?: number
          purchase_date?: string | null
          registration?: string | null
          registration_annual?: number
          target_hours_per_year?: number
          updated_at?: string | null
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "equipment_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "equipment_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      equipment_documents: {
        Row: {
          created_at: string | null
          equipment_id: string
          file_name: string
          file_size: number | null
          file_type: string | null
          id: string
          storage_path: string
          uploaded_by: string | null
        }
        Insert: {
          created_at?: string | null
          equipment_id: string
          file_name: string
          file_size?: number | null
          file_type?: string | null
          id?: string
          storage_path: string
          uploaded_by?: string | null
        }
        Update: {
          created_at?: string | null
          equipment_id?: string
          file_name?: string
          file_size?: number | null
          file_type?: string | null
          id?: string
          storage_path?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "equipment_documents_equipment_id_fkey"
            columns: ["equipment_id"]
            isOneToOne: false
            referencedRelation: "equipment"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "equipment_documents_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      equipment_expenses: {
        Row: {
          amount: number
          category: string
          created_at: string | null
          description: string | null
          equipment_id: string
          expense_date: string
          gst_amount: number
          id: string
          invoice_number: string | null
          logged_by: string | null
          receipt_storage_path: string | null
          supplier_name: string | null
        }
        Insert: {
          amount?: number
          category?: string
          created_at?: string | null
          description?: string | null
          equipment_id: string
          expense_date?: string
          gst_amount?: number
          id?: string
          invoice_number?: string | null
          logged_by?: string | null
          receipt_storage_path?: string | null
          supplier_name?: string | null
        }
        Update: {
          amount?: number
          category?: string
          created_at?: string | null
          description?: string | null
          equipment_id?: string
          expense_date?: string
          gst_amount?: number
          id?: string
          invoice_number?: string | null
          logged_by?: string | null
          receipt_storage_path?: string | null
          supplier_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "equipment_expenses_equipment_id_fkey"
            columns: ["equipment_id"]
            isOneToOne: false
            referencedRelation: "equipment"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "equipment_expenses_logged_by_fkey"
            columns: ["logged_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      equipment_usage_log: {
        Row: {
          created_at: string | null
          equipment_id: string
          hours: number
          id: string
          job_id: string | null
          logged_by: string | null
          notes: string | null
          usage_date: string
        }
        Insert: {
          created_at?: string | null
          equipment_id: string
          hours: number
          id?: string
          job_id?: string | null
          logged_by?: string | null
          notes?: string | null
          usage_date?: string
        }
        Update: {
          created_at?: string | null
          equipment_id?: string
          hours?: number
          id?: string
          job_id?: string | null
          logged_by?: string | null
          notes?: string | null
          usage_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "equipment_usage_log_equipment_id_fkey"
            columns: ["equipment_id"]
            isOneToOne: false
            referencedRelation: "equipment"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "equipment_usage_log_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "equipment_usage_log_logged_by_fkey"
            columns: ["logged_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      google_tokens: {
        Row: {
          access_token: string
          calendar_last_synced_at: string | null
          calendar_sync_token: string | null
          created_at: string | null
          google_email: string | null
          id: string
          refresh_token: string
          token_expiry: string
          updated_at: string | null
        }
        Insert: {
          access_token: string
          calendar_last_synced_at?: string | null
          calendar_sync_token?: string | null
          created_at?: string | null
          google_email?: string | null
          id?: string
          refresh_token: string
          token_expiry: string
          updated_at?: string | null
        }
        Update: {
          access_token?: string
          calendar_last_synced_at?: string | null
          calendar_sync_token?: string | null
          created_at?: string | null
          google_email?: string | null
          id?: string
          refresh_token?: string
          token_expiry?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      inventory: {
        Row: {
          category: string | null
          created_at: string | null
          description: string | null
          id: string
          is_active: boolean | null
          name: string
          quantity_on_hand: number | null
          reorder_level: number | null
          sku: string | null
          supplier: string | null
          unit: string | null
          unit_cost: number | null
          unit_sell: number | null
          updated_at: string | null
        }
        Insert: {
          category?: string | null
          created_at?: string | null
          description?: string | null
          id?: string
          is_active?: boolean | null
          name: string
          quantity_on_hand?: number | null
          reorder_level?: number | null
          sku?: string | null
          supplier?: string | null
          unit?: string | null
          unit_cost?: number | null
          unit_sell?: number | null
          updated_at?: string | null
        }
        Update: {
          category?: string | null
          created_at?: string | null
          description?: string | null
          id?: string
          is_active?: boolean | null
          name?: string
          quantity_on_hand?: number | null
          reorder_level?: number | null
          sku?: string | null
          supplier?: string | null
          unit?: string | null
          unit_cost?: number | null
          unit_sell?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
      invoice_items: {
        Row: {
          created_at: string | null
          description: string | null
          id: string
          invoice_id: string
          name: string
          pricing_item_id: string | null
          quantity: number | null
          total: number | null
          unit_price: number
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          id?: string
          invoice_id: string
          name: string
          pricing_item_id?: string | null
          quantity?: number | null
          total?: number | null
          unit_price: number
        }
        Update: {
          created_at?: string | null
          description?: string | null
          id?: string
          invoice_id?: string
          name?: string
          pricing_item_id?: string | null
          quantity?: number | null
          total?: number | null
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "invoice_items_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_items_pricing_item_id_fkey"
            columns: ["pricing_item_id"]
            isOneToOne: false
            referencedRelation: "pricing_items"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          amount_paid: number | null
          created_at: string | null
          created_by: string | null
          customer_id: string
          due_date: string | null
          id: string
          invoice_number: number
          job_id: string | null
          notes: string | null
          paid_at: string | null
          quote_id: string | null
          status: string
          subtotal: number | null
          tax_amount: number | null
          tax_rate: number | null
          title: string
          total: number | null
          updated_at: string | null
          work_description: string | null
          xero_invoice_id: string | null
        }
        Insert: {
          amount_paid?: number | null
          created_at?: string | null
          created_by?: string | null
          customer_id: string
          due_date?: string | null
          id?: string
          invoice_number?: number
          job_id?: string | null
          notes?: string | null
          paid_at?: string | null
          quote_id?: string | null
          status?: string
          subtotal?: number | null
          tax_amount?: number | null
          tax_rate?: number | null
          title: string
          total?: number | null
          updated_at?: string | null
          work_description?: string | null
          xero_invoice_id?: string | null
        }
        Update: {
          amount_paid?: number | null
          created_at?: string | null
          created_by?: string | null
          customer_id?: string
          due_date?: string | null
          id?: string
          invoice_number?: number
          job_id?: string | null
          notes?: string | null
          paid_at?: string | null
          quote_id?: string | null
          status?: string
          subtotal?: number | null
          tax_amount?: number | null
          tax_rate?: number | null
          title?: string
          total?: number | null
          updated_at?: string | null
          work_description?: string | null
          xero_invoice_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoices_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
        ]
      }
      job_documents: {
        Row: {
          created_at: string | null
          file_name: string
          file_size: number | null
          file_type: string | null
          id: string
          job_id: string
          simpro_file_id: string | null
          storage_path: string
          uploaded_by: string | null
        }
        Insert: {
          created_at?: string | null
          file_name: string
          file_size?: number | null
          file_type?: string | null
          id?: string
          job_id: string
          simpro_file_id?: string | null
          storage_path: string
          uploaded_by?: string | null
        }
        Update: {
          created_at?: string | null
          file_name?: string
          file_size?: number | null
          file_type?: string | null
          id?: string
          job_id?: string
          simpro_file_id?: string | null
          storage_path?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "job_documents_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_documents_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      job_expenses: {
        Row: {
          amount: number
          category: string
          cost_center_id: string | null
          created_at: string | null
          description: string | null
          entered_by: string | null
          gst_amount: number
          id: string
          invoice_date: string | null
          invoice_number: string | null
          job_id: string
          receipt_storage_path: string | null
          supplier_name: string
          xero_bill_id: string | null
          xero_synced_at: string | null
        }
        Insert: {
          amount?: number
          category?: string
          cost_center_id?: string | null
          created_at?: string | null
          description?: string | null
          entered_by?: string | null
          gst_amount?: number
          id?: string
          invoice_date?: string | null
          invoice_number?: string | null
          job_id: string
          receipt_storage_path?: string | null
          supplier_name: string
          xero_bill_id?: string | null
          xero_synced_at?: string | null
        }
        Update: {
          amount?: number
          category?: string
          cost_center_id?: string | null
          created_at?: string | null
          description?: string | null
          entered_by?: string | null
          gst_amount?: number
          id?: string
          invoice_date?: string | null
          invoice_number?: string | null
          job_id?: string
          receipt_storage_path?: string | null
          supplier_name?: string
          xero_bill_id?: string | null
          xero_synced_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "job_expenses_cost_center_id_fkey"
            columns: ["cost_center_id"]
            isOneToOne: false
            referencedRelation: "po_cost_centers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_expenses_cost_center_id_fkey"
            columns: ["cost_center_id"]
            isOneToOne: false
            referencedRelation: "po_cost_centers_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_expenses_entered_by_fkey"
            columns: ["entered_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_expenses_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      job_items: {
        Row: {
          created_at: string | null
          description: string | null
          id: string
          job_id: string
          name: string
          pricing_item_id: string | null
          quantity: number | null
          source: string
          staff_id: string | null
          time_entry_id: string | null
          total: number | null
          unit_price: number
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          id?: string
          job_id: string
          name: string
          pricing_item_id?: string | null
          quantity?: number | null
          source?: string
          staff_id?: string | null
          time_entry_id?: string | null
          total?: number | null
          unit_price: number
        }
        Update: {
          created_at?: string | null
          description?: string | null
          id?: string
          job_id?: string
          name?: string
          pricing_item_id?: string | null
          quantity?: number | null
          source?: string
          staff_id?: string | null
          time_entry_id?: string | null
          total?: number | null
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "job_items_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_items_pricing_item_id_fkey"
            columns: ["pricing_item_id"]
            isOneToOne: false
            referencedRelation: "pricing_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_items_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_items_time_entry_id_fkey"
            columns: ["time_entry_id"]
            isOneToOne: false
            referencedRelation: "time_entries"
            referencedColumns: ["id"]
          },
        ]
      }
      job_notes: {
        Row: {
          author_id: string | null
          content: string
          created_at: string | null
          id: string
          job_id: string
        }
        Insert: {
          author_id?: string | null
          content: string
          created_at?: string | null
          id?: string
          job_id: string
        }
        Update: {
          author_id?: string | null
          content?: string
          created_at?: string | null
          id?: string
          job_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_notes_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_notes_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      job_photos: {
        Row: {
          caption: string | null
          created_at: string | null
          id: string
          job_id: string
          photo_type: string | null
          simpro_file_id: string | null
          storage_path: string
          uploaded_by: string | null
        }
        Insert: {
          caption?: string | null
          created_at?: string | null
          id?: string
          job_id: string
          photo_type?: string | null
          simpro_file_id?: string | null
          storage_path: string
          uploaded_by?: string | null
        }
        Update: {
          caption?: string | null
          created_at?: string | null
          id?: string
          job_id?: string
          photo_type?: string | null
          simpro_file_id?: string | null
          storage_path?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "job_photos_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_photos_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      job_variations: {
        Row: {
          admin_notes: string | null
          approved_at: string | null
          approved_by: string | null
          attachment_file_name: string | null
          attachment_storage_path: string | null
          created_at: string | null
          custom_name: string | null
          description: string | null
          id: string
          invoice_id: string | null
          job_id: string
          logged_at: string | null
          logged_by: string | null
          photo_storage_path: string | null
          quantity: number
          rate: number | null
          status: string
          total_amount: number | null
          unit: string
          variation_type_id: string | null
        }
        Insert: {
          admin_notes?: string | null
          approved_at?: string | null
          approved_by?: string | null
          attachment_file_name?: string | null
          attachment_storage_path?: string | null
          created_at?: string | null
          custom_name?: string | null
          description?: string | null
          id?: string
          invoice_id?: string | null
          job_id: string
          logged_at?: string | null
          logged_by?: string | null
          photo_storage_path?: string | null
          quantity?: number
          rate?: number | null
          status?: string
          total_amount?: number | null
          unit?: string
          variation_type_id?: string | null
        }
        Update: {
          admin_notes?: string | null
          approved_at?: string | null
          approved_by?: string | null
          attachment_file_name?: string | null
          attachment_storage_path?: string | null
          created_at?: string | null
          custom_name?: string | null
          description?: string | null
          id?: string
          invoice_id?: string | null
          job_id?: string
          logged_at?: string | null
          logged_by?: string | null
          photo_storage_path?: string | null
          quantity?: number
          rate?: number | null
          status?: string
          total_amount?: number | null
          unit?: string
          variation_type_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "job_variations_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_variations_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_variations_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_variations_logged_by_fkey"
            columns: ["logged_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_variations_variation_type_id_fkey"
            columns: ["variation_type_id"]
            isOneToOne: false
            referencedRelation: "variation_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_variations_variation_type_id_fkey"
            columns: ["variation_type_id"]
            isOneToOne: false
            referencedRelation: "variation_types_public"
            referencedColumns: ["id"]
          },
        ]
      }
      jobs: {
        Row: {
          actual_end: string | null
          actual_start: string | null
          admin_notes: string | null
          admin_status: string | null
          assigned_to: string | null
          completion_notes: string | null
          created_at: string | null
          created_by: string | null
          customer_id: string
          description: string | null
          google_event_id: string | null
          id: string
          job_number: number
          job_type: string | null
          notes: string | null
          overtime_category: string | null
          overtime_logged_at: string | null
          overtime_logged_by: string | null
          overtime_reason: string | null
          priority: string
          ready_to_invoice: boolean
          scheduled_end: string | null
          scheduled_start: string | null
          simpro_job_id: number | null
          site_id: string | null
          status: string
          title: string
          updated_at: string | null
          voice_report_recorded_at: string | null
          voice_report_recorded_by: string | null
          voice_report_storage_path: string | null
          voice_report_transcript: string | null
        }
        Insert: {
          actual_end?: string | null
          actual_start?: string | null
          admin_notes?: string | null
          admin_status?: string | null
          assigned_to?: string | null
          completion_notes?: string | null
          created_at?: string | null
          created_by?: string | null
          customer_id: string
          description?: string | null
          google_event_id?: string | null
          id?: string
          job_number?: number
          job_type?: string | null
          notes?: string | null
          overtime_category?: string | null
          overtime_logged_at?: string | null
          overtime_logged_by?: string | null
          overtime_reason?: string | null
          priority?: string
          ready_to_invoice?: boolean
          scheduled_end?: string | null
          scheduled_start?: string | null
          simpro_job_id?: number | null
          site_id?: string | null
          status?: string
          title: string
          updated_at?: string | null
          voice_report_recorded_at?: string | null
          voice_report_recorded_by?: string | null
          voice_report_storage_path?: string | null
          voice_report_transcript?: string | null
        }
        Update: {
          actual_end?: string | null
          actual_start?: string | null
          admin_notes?: string | null
          admin_status?: string | null
          assigned_to?: string | null
          completion_notes?: string | null
          created_at?: string | null
          created_by?: string | null
          customer_id?: string
          description?: string | null
          google_event_id?: string | null
          id?: string
          job_number?: number
          job_type?: string | null
          notes?: string | null
          overtime_category?: string | null
          overtime_logged_at?: string | null
          overtime_logged_by?: string | null
          overtime_reason?: string | null
          priority?: string
          ready_to_invoice?: boolean
          scheduled_end?: string | null
          scheduled_start?: string | null
          simpro_job_id?: number | null
          site_id?: string | null
          status?: string
          title?: string
          updated_at?: string | null
          voice_report_recorded_at?: string | null
          voice_report_recorded_by?: string | null
          voice_report_storage_path?: string | null
          voice_report_transcript?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "jobs_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_overtime_logged_by_fkey"
            columns: ["overtime_logged_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: false
            referencedRelation: "sites"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_voice_report_recorded_by_fkey"
            columns: ["voice_report_recorded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      po_cost_centers: {
        Row: {
          allocated_amount: number | null
          allocated_hours: number | null
          code: string | null
          created_at: string | null
          id: string
          name: string
          po_id: string
          sort_order: number | null
        }
        Insert: {
          allocated_amount?: number | null
          allocated_hours?: number | null
          code?: string | null
          created_at?: string | null
          id?: string
          name: string
          po_id: string
          sort_order?: number | null
        }
        Update: {
          allocated_amount?: number | null
          allocated_hours?: number | null
          code?: string | null
          created_at?: string | null
          id?: string
          name?: string
          po_id?: string
          sort_order?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "po_cost_centers_po_id_fkey"
            columns: ["po_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "po_cost_centers_po_id_fkey"
            columns: ["po_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders_public"
            referencedColumns: ["id"]
          },
        ]
      }
      pricing_items: {
        Row: {
          category: string
          created_at: string | null
          description: string | null
          id: string
          is_active: boolean | null
          name: string
          pricing_type: string
          unit: string | null
          unit_price: number
          updated_at: string | null
        }
        Insert: {
          category: string
          created_at?: string | null
          description?: string | null
          id?: string
          is_active?: boolean | null
          name: string
          pricing_type: string
          unit?: string | null
          unit_price: number
          updated_at?: string | null
        }
        Update: {
          category?: string
          created_at?: string | null
          description?: string | null
          id?: string
          is_active?: boolean | null
          name?: string
          pricing_type?: string
          unit?: string | null
          unit_price?: number
          updated_at?: string | null
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string | null
          email: string
          full_name: string
          id: string
          is_active: boolean | null
          phone: string | null
          role: string
          updated_at: string | null
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string | null
          email: string
          full_name: string
          id: string
          is_active?: boolean | null
          phone?: string | null
          role: string
          updated_at?: string | null
        }
        Update: {
          avatar_url?: string | null
          created_at?: string | null
          email?: string
          full_name?: string
          id?: string
          is_active?: boolean | null
          phone?: string | null
          role?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      purchase_orders: {
        Row: {
          client_reference: string | null
          created_at: string | null
          id: string
          job_id: string
          notes: string | null
          po_number: string
          site_address: string | null
          site_lat: number | null
          site_lng: number | null
          total_hours: number | null
          total_value: number | null
          updated_at: string | null
        }
        Insert: {
          client_reference?: string | null
          created_at?: string | null
          id?: string
          job_id: string
          notes?: string | null
          po_number: string
          site_address?: string | null
          site_lat?: number | null
          site_lng?: number | null
          total_hours?: number | null
          total_value?: number | null
          updated_at?: string | null
        }
        Update: {
          client_reference?: string | null
          created_at?: string | null
          id?: string
          job_id?: string
          notes?: string | null
          po_number?: string
          site_address?: string | null
          site_lat?: number | null
          site_lng?: number | null
          total_hours?: number | null
          total_value?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "purchase_orders_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      quote_items: {
        Row: {
          created_at: string | null
          description: string | null
          id: string
          name: string
          pricing_item_id: string | null
          quantity: number | null
          quote_id: string
          total: number | null
          unit_price: number
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          id?: string
          name: string
          pricing_item_id?: string | null
          quantity?: number | null
          quote_id: string
          total?: number | null
          unit_price: number
        }
        Update: {
          created_at?: string | null
          description?: string | null
          id?: string
          name?: string
          pricing_item_id?: string | null
          quantity?: number | null
          quote_id?: string
          total?: number | null
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "quote_items_pricing_item_id_fkey"
            columns: ["pricing_item_id"]
            isOneToOne: false
            referencedRelation: "pricing_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quote_items_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
        ]
      }
      quotes: {
        Row: {
          created_at: string | null
          created_by: string | null
          customer_id: string
          description: string | null
          id: string
          job_id: string | null
          notes: string | null
          quote_number: number
          site_id: string | null
          status: string
          subtotal: number | null
          tax_amount: number | null
          tax_rate: number | null
          title: string
          total: number | null
          updated_at: string | null
          valid_until: string | null
          xero_quote_id: string | null
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          customer_id: string
          description?: string | null
          id?: string
          job_id?: string | null
          notes?: string | null
          quote_number?: number
          site_id?: string | null
          status?: string
          subtotal?: number | null
          tax_amount?: number | null
          tax_rate?: number | null
          title: string
          total?: number | null
          updated_at?: string | null
          valid_until?: string | null
          xero_quote_id?: string | null
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          customer_id?: string
          description?: string | null
          id?: string
          job_id?: string | null
          notes?: string | null
          quote_number?: number
          site_id?: string | null
          status?: string
          subtotal?: number | null
          tax_amount?: number | null
          tax_rate?: number | null
          title?: string
          total?: number | null
          updated_at?: string | null
          valid_until?: string | null
          xero_quote_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "quotes_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: false
            referencedRelation: "sites"
            referencedColumns: ["id"]
          },
        ]
      }
      sites: {
        Row: {
          address_line1: string
          address_line2: string | null
          created_at: string | null
          customer_id: string
          id: string
          name: string
          notes: string | null
          postcode: string
          simpro_site_id: number | null
          site_lat: number | null
          site_lng: number | null
          state: string
          suburb: string
          updated_at: string | null
        }
        Insert: {
          address_line1: string
          address_line2?: string | null
          created_at?: string | null
          customer_id: string
          id?: string
          name: string
          notes?: string | null
          postcode: string
          simpro_site_id?: number | null
          site_lat?: number | null
          site_lng?: number | null
          state: string
          suburb: string
          updated_at?: string | null
        }
        Update: {
          address_line1?: string
          address_line2?: string | null
          created_at?: string | null
          customer_id?: string
          id?: string
          name?: string
          notes?: string | null
          postcode?: string
          simpro_site_id?: number | null
          site_lat?: number | null
          site_lng?: number | null
          state?: string
          suburb?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sites_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_cost_profiles: {
        Row: {
          annual_fixed_oncosts: number
          charge_out_rate: number | null
          hourly_rate: number
          leave_loading_rate: number
          staff_id: string
          super_rate: number
          target_hours_per_week: number
          trade_level: string
          updated_at: string | null
          updated_by: string | null
          workers_comp_rate: number
        }
        Insert: {
          annual_fixed_oncosts?: number
          charge_out_rate?: number | null
          hourly_rate?: number
          leave_loading_rate?: number
          staff_id: string
          super_rate?: number
          target_hours_per_week?: number
          trade_level?: string
          updated_at?: string | null
          updated_by?: string | null
          workers_comp_rate?: number
        }
        Update: {
          annual_fixed_oncosts?: number
          charge_out_rate?: number | null
          hourly_rate?: number
          leave_loading_rate?: number
          staff_id?: string
          super_rate?: number
          target_hours_per_week?: number
          trade_level?: string
          updated_at?: string | null
          updated_by?: string | null
          workers_comp_rate?: number
        }
        Relationships: [
          {
            foreignKeyName: "staff_cost_profiles_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_cost_profiles_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_leave: {
        Row: {
          created_at: string | null
          created_by: string | null
          end_date: string
          hours: number
          id: string
          leave_type: string
          notes: string | null
          staff_id: string
          start_date: string
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          end_date: string
          hours: number
          id?: string
          leave_type: string
          notes?: string | null
          staff_id: string
          start_date: string
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          end_date?: string
          hours?: number
          id?: string
          leave_type?: string
          notes?: string | null
          staff_id?: string
          start_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_leave_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_leave_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      time_entries: {
        Row: {
          auto_clocked: boolean | null
          clock_in: string
          clock_out: string | null
          cost_center_id: string | null
          created_at: string | null
          edited_at: string | null
          edited_by: string | null
          entry_type: string
          hours: number | null
          id: string
          job_id: string
          notes: string | null
          rate_override: string | null
          staff_id: string
          travel_from_job_id: string | null
        }
        Insert: {
          auto_clocked?: boolean | null
          clock_in?: string
          clock_out?: string | null
          cost_center_id?: string | null
          created_at?: string | null
          edited_at?: string | null
          edited_by?: string | null
          entry_type?: string
          hours?: number | null
          id?: string
          job_id: string
          notes?: string | null
          rate_override?: string | null
          staff_id: string
          travel_from_job_id?: string | null
        }
        Update: {
          auto_clocked?: boolean | null
          clock_in?: string
          clock_out?: string | null
          cost_center_id?: string | null
          created_at?: string | null
          edited_at?: string | null
          edited_by?: string | null
          entry_type?: string
          hours?: number | null
          id?: string
          job_id?: string
          notes?: string | null
          rate_override?: string | null
          staff_id?: string
          travel_from_job_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "time_entries_cost_center_id_fkey"
            columns: ["cost_center_id"]
            isOneToOne: false
            referencedRelation: "po_cost_centers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "time_entries_cost_center_id_fkey"
            columns: ["cost_center_id"]
            isOneToOne: false
            referencedRelation: "po_cost_centers_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "time_entries_edited_by_fkey"
            columns: ["edited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "time_entries_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "time_entries_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "time_entries_travel_from_job_id_fkey"
            columns: ["travel_from_job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      variation_types: {
        Row: {
          auto_approve: boolean
          created_at: string | null
          id: string
          is_active: boolean
          name: string
          rate: number
          unit: string
        }
        Insert: {
          auto_approve?: boolean
          created_at?: string | null
          id?: string
          is_active?: boolean
          name: string
          rate?: number
          unit?: string
        }
        Update: {
          auto_approve?: boolean
          created_at?: string | null
          id?: string
          is_active?: boolean
          name?: string
          rate?: number
          unit?: string
        }
        Relationships: []
      }
      xero_tokens: {
        Row: {
          access_token: string
          created_at: string | null
          default_expense_account_code: string | null
          default_sales_account_code: string | null
          id: string
          refresh_token: string
          tenant_id: string | null
          tenant_name: string | null
          token_expiry: string
          updated_at: string | null
          xero_invoice_last_synced_at: string | null
        }
        Insert: {
          access_token: string
          created_at?: string | null
          default_expense_account_code?: string | null
          default_sales_account_code?: string | null
          id?: string
          refresh_token: string
          tenant_id?: string | null
          tenant_name?: string | null
          token_expiry: string
          updated_at?: string | null
          xero_invoice_last_synced_at?: string | null
        }
        Update: {
          access_token?: string
          created_at?: string | null
          default_expense_account_code?: string | null
          default_sales_account_code?: string | null
          id?: string
          refresh_token?: string
          tenant_id?: string | null
          tenant_name?: string | null
          token_expiry?: string
          updated_at?: string | null
          xero_invoice_last_synced_at?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      job_variations_public: {
        Row: {
          approved_at: string | null
          attachment_file_name: string | null
          attachment_storage_path: string | null
          created_at: string | null
          custom_name: string | null
          description: string | null
          id: string | null
          invoice_id: string | null
          job_id: string | null
          logged_at: string | null
          logged_by: string | null
          photo_storage_path: string | null
          quantity: number | null
          status: string | null
          unit: string | null
          variation_type_id: string | null
        }
        Insert: {
          approved_at?: string | null
          attachment_file_name?: string | null
          attachment_storage_path?: string | null
          created_at?: string | null
          custom_name?: string | null
          description?: string | null
          id?: string | null
          invoice_id?: string | null
          job_id?: string | null
          logged_at?: string | null
          logged_by?: string | null
          photo_storage_path?: string | null
          quantity?: number | null
          status?: string | null
          unit?: string | null
          variation_type_id?: string | null
        }
        Update: {
          approved_at?: string | null
          attachment_file_name?: string | null
          attachment_storage_path?: string | null
          created_at?: string | null
          custom_name?: string | null
          description?: string | null
          id?: string | null
          invoice_id?: string | null
          job_id?: string | null
          logged_at?: string | null
          logged_by?: string | null
          photo_storage_path?: string | null
          quantity?: number | null
          status?: string | null
          unit?: string | null
          variation_type_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "job_variations_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_variations_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_variations_logged_by_fkey"
            columns: ["logged_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_variations_variation_type_id_fkey"
            columns: ["variation_type_id"]
            isOneToOne: false
            referencedRelation: "variation_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_variations_variation_type_id_fkey"
            columns: ["variation_type_id"]
            isOneToOne: false
            referencedRelation: "variation_types_public"
            referencedColumns: ["id"]
          },
        ]
      }
      po_cost_centers_public: {
        Row: {
          allocated_hours: number | null
          code: string | null
          created_at: string | null
          id: string | null
          name: string | null
          po_id: string | null
          sort_order: number | null
        }
        Insert: {
          allocated_hours?: number | null
          code?: string | null
          created_at?: string | null
          id?: string | null
          name?: string | null
          po_id?: string | null
          sort_order?: number | null
        }
        Update: {
          allocated_hours?: number | null
          code?: string | null
          created_at?: string | null
          id?: string | null
          name?: string | null
          po_id?: string | null
          sort_order?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "po_cost_centers_po_id_fkey"
            columns: ["po_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "po_cost_centers_po_id_fkey"
            columns: ["po_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders_public"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_orders_public: {
        Row: {
          client_reference: string | null
          created_at: string | null
          id: string | null
          job_id: string | null
          po_number: string | null
          total_hours: number | null
        }
        Insert: {
          client_reference?: string | null
          created_at?: string | null
          id?: string | null
          job_id?: string | null
          po_number?: string | null
          total_hours?: number | null
        }
        Update: {
          client_reference?: string | null
          created_at?: string | null
          id?: string | null
          job_id?: string | null
          po_number?: string | null
          total_hours?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "purchase_orders_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      variation_types_public: {
        Row: {
          auto_approve: boolean | null
          created_at: string | null
          id: string | null
          is_active: boolean | null
          name: string | null
          unit: string | null
        }
        Insert: {
          auto_approve?: boolean | null
          created_at?: string | null
          id?: string | null
          is_active?: boolean | null
          name?: string | null
          unit?: string | null
        }
        Update: {
          auto_approve?: boolean | null
          created_at?: string | null
          id?: string | null
          is_active?: boolean | null
          name?: string | null
          unit?: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      is_admin: { Args: { uid: string }; Returns: boolean }
      is_office_or_admin: { Args: { uid: string }; Returns: boolean }
      reapply_time_entries_grants: { Args: never; Returns: undefined }
      storage_object_is_money_document: {
        Args: { object_name: string }
        Returns: boolean
      }
    }
    Enums: {
      [_ in never]: never
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
  public: {
    Enums: {},
  },
} as const
